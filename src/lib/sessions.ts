import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Env } from '../env.js';
import type { ChatMessage } from './openrouter.js';
import type { SessionContext } from './session-context.js';

// Session store for /talk. Public clients (REST + MCP) cannot be trusted to
// maintain history themselves, so the server threads turns by session_id.
//
// State is now persisted to disk (one JSON file per session under
// `<dataDir>/sessions/`) so a server restart does not nuke every caller's
// conversation. The in-memory Map remains the hot path; disk writes happen
// synchronously on every append. Volume is small (tens of KB per active
// session) and write latency is dwarfed by the OpenRouter round-trip, so
// the simple approach is fine.

export interface Session {
  id: string;
  messages: ChatMessage[];
  createdAt: number;
  lastAccessedAt: number;
  turnCount: number;
  sessionContextCache?: {
    key: string;
    value: SessionContext | null;
  };
}

export interface SessionStore {
  getOrCreate(sessionId?: string | null): { session: Session; created: boolean };
  append(id: string, role: ChatMessage['role'], content: string): void;
  /**
   * Thread an inbound news item into the shared conversation memory. News and
   * talk are two inbound channels onto the SAME session: a news item becomes
   * part of the conversation the model sees on subsequent /talk turns, in
   * arrival order. Unlike a /talk turn it does NOT count toward the session
   * turn cap (news is fire-and-forget), but it IS persisted and threaded.
   */
  threadNews(id: string, from: string, message: string): void;
  getSessionContext(id: string, key: string): SessionContext | null | undefined;
  setSessionContext(id: string, key: string, value: SessionContext | null): void;
  clearSessionContextCache(): void;
  resetAll(): number;
  has(sessionId: string): boolean;
  all(): Session[];
  purgeIdle(now?: number): number;
  size(): number;
  limits(): { maxSessions: number; idleMs: number; maxTurns: number };
}

function newSessionId(): string {
  return crypto.randomUUID();
}

/**
 * Render a news item as a conversation message. Because news and talk share one
 * session memory, a news item enters that memory as an inbound message from its
 * sender, explicitly marked no-reply/no-processing so the model treats it as
 * received context/fact rather than a question to answer retroactively.
 */
export function formatInboundNews(from: string, message: string): string {
  const sender = from.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim() || 'unknown';
  return `[news notification from ${sender}; no-reply; no-processing]\n${message}`;
}

function sessionsDir(env: Env): string {
  return path.join(env.dataDir, 'sessions');
}

function sessionPath(env: Env, id: string): string {
  // Validate id shape so we can't be tricked into escaping the sessions dir.
  if (!/^[a-f0-9-]{36}$/i.test(id)) {
    throw new Error(`invalid session id shape: ${id}`);
  }
  return path.join(sessionsDir(env), `${id}.json`);
}

function writeSession(env: Env, s: Session): void {
  fs.mkdirSync(sessionsDir(env), { recursive: true });
  fs.writeFileSync(sessionPath(env, s.id), JSON.stringify(s));
}

function loadAllFromDisk(env: Env, idleMs: number): Map<string, Session> {
  const map = new Map<string, Session>();
  const dir = sessionsDir(env);
  if (!fs.existsSync(dir)) return map;
  const now = Date.now();
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const s = JSON.parse(raw) as Session;
      // Drop sessions that were already idle past TTL when we loaded.
      if (idleMs > 0 && now - s.lastAccessedAt > idleMs) {
        fs.unlinkSync(file);
        continue;
      }
      map.set(s.id, s);
    } catch {
      // Skip malformed files rather than crash on boot.
    }
  }
  return map;
}

export function createSessionStore(env: Env): SessionStore {
  const idleMs = env.sessionIdleMinutes * 60_000;
  const maxSessions = env.maxSessions;
  const maxTurns = env.maxTurnsPerSession;
  const sessions = loadAllFromDisk(env, idleMs);

  function purgeIdle(now: number = Date.now()): number {
    if (idleMs <= 0) return 0;
    let removed = 0;
    for (const [id, s] of sessions) {
      if (now - s.lastAccessedAt > idleMs) {
        sessions.delete(id);
        try {
          fs.unlinkSync(sessionPath(env, id));
        } catch {
          // already gone
        }
        removed++;
      }
    }
    return removed;
  }

  function evictOldest(): void {
    if (maxSessions <= 0) return;
    while (sessions.size >= maxSessions) {
      let oldestId: string | null = null;
      let oldestAt = Infinity;
      for (const [id, s] of sessions) {
        if (s.lastAccessedAt < oldestAt) {
          oldestAt = s.lastAccessedAt;
          oldestId = id;
        }
      }
      if (!oldestId) break;
      sessions.delete(oldestId);
      try {
        fs.unlinkSync(sessionPath(env, oldestId));
      } catch {
        // already gone
      }
    }
  }

  return {
    getOrCreate(sessionId) {
      const now = Date.now();
      purgeIdle(now);
      if (sessionId) {
        const existing = sessions.get(sessionId);
        if (existing) {
          existing.lastAccessedAt = now;
          writeSession(env, existing);
          return { session: existing, created: false };
        }
      }
      evictOldest();
      const id = newSessionId();
      const session: Session = {
        id,
        messages: [],
        createdAt: now,
        lastAccessedAt: now,
        turnCount: 0,
      };
      sessions.set(id, session);
      writeSession(env, session);
      return { session, created: true };
    },
    append(id, role, content) {
      const s = sessions.get(id);
      if (!s) return;
      s.messages.push({ role, content });
      s.lastAccessedAt = Date.now();
      if (role === 'user') s.turnCount += 1;
      writeSession(env, s);
    },
    threadNews(id, from, message) {
      const s = sessions.get(id);
      if (!s) return;
      // Inbound news joins the shared conversation as a no-reply notification.
      // Intentionally does NOT bump turnCount — news must not consume the
      // caller's /talk turn budget.
      s.messages.push({ role: 'user', content: formatInboundNews(from, message) });
      s.lastAccessedAt = Date.now();
      writeSession(env, s);
    },
    getSessionContext(id, key) {
      const s = sessions.get(id);
      if (!s || s.sessionContextCache?.key !== key) return undefined;
      return s.sessionContextCache.value;
    },
    setSessionContext(id, key, value) {
      const s = sessions.get(id);
      if (!s) return;
      s.sessionContextCache = { key, value };
      s.lastAccessedAt = Date.now();
      writeSession(env, s);
    },
    clearSessionContextCache() {
      for (const s of sessions.values()) {
        if (!s.sessionContextCache) continue;
        delete s.sessionContextCache;
        s.lastAccessedAt = Date.now();
        writeSession(env, s);
      }
    },
    resetAll() {
      const count = sessions.size;
      for (const id of Array.from(sessions.keys())) {
        sessions.delete(id);
        try {
          fs.unlinkSync(sessionPath(env, id));
        } catch {
          // already gone
        }
      }
      return count;
    },
    has(sessionId) {
      purgeIdle();
      return sessions.has(sessionId);
    },
    all() {
      return Array.from(sessions.values());
    },
    purgeIdle,
    size() {
      return sessions.size;
    },
    limits() {
      return { maxSessions, idleMs, maxTurns };
    },
  };
}
