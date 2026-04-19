import fs from 'node:fs';
import path from 'node:path';
import type { Env } from '../env.js';

export interface NewsItem {
  id: number;
  timestamp: number;       // ms since epoch
  type: string;            // 'notify' | 'message' | caller-supplied
  from: string;
  message: string;
  data?: unknown;
  /**
   * UUIDv4 tying this item to a /talk session. Items posted via the public
   * /news endpoint always have a session_id (the public endpoint requires
   * one). Items posted via the operator /news may omit it. GET /news on the
   * public listener filters by session_id so callers only ever see their
   * own.
   */
  session_id?: string;
}

function logPath(env: Env): string {
  return path.join(env.dataDir, 'news.log');
}

function ensureDir(env: Env): void {
  fs.mkdirSync(env.dataDir, { recursive: true });
}

// Use a single monotonic counter kept in memory. On cold start, scan the last
// line of the log to resume numbering. Cheap for the volumes this agent will
// realistically see; swap to a sqlite index if we outgrow it.
let nextId = 0;
let initialised = false;

function initCounter(env: Env): void {
  if (initialised) return;
  initialised = true;
  const file = logPath(env);
  if (!fs.existsSync(file)) {
    nextId = 1;
    return;
  }
  const raw = fs.readFileSync(file, 'utf8');
  const lines = raw.trim().split('\n').filter(Boolean);
  if (lines.length === 0) {
    nextId = 1;
    return;
  }
  try {
    const last = JSON.parse(lines[lines.length - 1]!) as NewsItem;
    nextId = (last.id || 0) + 1;
  } catch {
    nextId = lines.length + 1;
  }
}

export function appendNews(
  env: Env,
  item: Omit<NewsItem, 'id' | 'timestamp'> & { timestamp?: number },
): NewsItem {
  ensureDir(env);
  initCounter(env);
  const full: NewsItem = {
    id: nextId++,
    timestamp: item.timestamp ?? Date.now(),
    type: item.type,
    from: item.from,
    message: item.message,
    ...(item.data !== undefined ? { data: item.data } : {}),
    ...(item.session_id ? { session_id: item.session_id } : {}),
  };
  fs.appendFileSync(logPath(env), JSON.stringify(full) + '\n');
  return full;
}

export function tailNews(
  env: Env,
  sinceId: number,
  limit: number,
  opts?: { sessionId?: string },
): { items: NewsItem[]; next_since_id: number } {
  const file = logPath(env);
  if (!fs.existsSync(file)) return { items: [], next_since_id: sinceId };
  const raw = fs.readFileSync(file, 'utf8');
  const items: NewsItem[] = [];
  let maxId = sinceId;
  const sessionFilter = opts?.sessionId;
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let item: NewsItem;
    try {
      item = JSON.parse(line) as NewsItem;
    } catch {
      continue;
    }
    if (item.id <= sinceId) continue;
    if (sessionFilter && item.session_id !== sessionFilter) continue;
    items.push(item);
    if (item.id > maxId) maxId = item.id;
  }
  const sliced = items.slice(0, limit);
  const nextSince = sliced.length > 0 ? sliced[sliced.length - 1]!.id : sinceId;
  return { items: sliced, next_since_id: nextSince };
}
