import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Env } from '../env.js';
import type { ChatMessage } from './openrouter.js';

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
}

export interface SessionStore {
  getOrCreate(sessionId?: string | null): { session: Session; created: boolean };
  append(id: string, role: ChatMessage['role'], content: string): void;
  has(sessionId: string): boolean;
  all(): Session[];
  purgeIdle(now?: number): number;
  size(): number;
  limits(): { maxSessions: number; idleMs: number; maxTurns: number };
}

function newSessionId(): string {
  return crypto.randomUUID();
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
