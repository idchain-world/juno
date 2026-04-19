import { Hono } from 'hono';
import type { Env } from '../env.js';
import type { SessionStore } from '../lib/sessions.js';
import { appendNews, tailNews } from '../lib/news-log.js';

// Session-scoped /news on the public listener.
//
// REST-AP uniformity: public agents expose the same /news verbs as local
// agents. The only difference is visibility — callers can only see news
// items tagged with their own session_id, and can only POST items that
// attach to a session they already own.
//
// A valid session_id (UUIDv4) is required on every call. Session IDs are
// minted by /talk on the first turn of a conversation; a caller who never
// hit /talk has no session and therefore no news access. That prevents
// drive-by spammers from creating inbox clutter and stops callers from
// reading each other's notes.

export function publicNewsRoutes(env: Env, sessions: SessionStore): Hono {
  const app = new Hono();

  app.post('/news', async (c) => {
    let body: {
      session_id?: string;
      type?: string;
      from?: string;
      message?: string;
      data?: unknown;
    };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    const sessionId = typeof body.session_id === 'string' ? body.session_id.trim() : '';
    const from = typeof body.from === 'string' ? body.from.trim() : '';
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (!sessionId) return c.json({ error: 'missing_session_id' }, 400);
    if (!from) return c.json({ error: 'missing_from' }, 400);
    if (!message) return c.json({ error: 'missing_message' }, 400);
    if (!sessions.has(sessionId)) {
      // 404 (not 403) so a probing caller can't distinguish "session
      // exists but isn't yours" from "no such session." Both look like
      // "there is no session here for you."
      return c.json({ error: 'unknown_session' }, 404);
    }
    const type = typeof body.type === 'string' && body.type.trim() ? body.type.trim() : 'notify';
    const item = appendNews(env, { type, from, message, data: body.data, session_id: sessionId });
    return c.json({ ok: true, id: item.id, timestamp: item.timestamp });
  });

  app.get('/news', (c) => {
    const sessionId = c.req.query('session_id')?.trim() ?? '';
    if (!sessionId) return c.json({ error: 'missing_session_id' }, 400);
    if (!sessions.has(sessionId)) {
      // Return an empty list rather than 404 so callers can't probe for
      // session existence. Bad session_id = no news.
      return c.json({ items: [], next_since_id: 0 });
    }
    const sinceId = Number(c.req.query('since_id') ?? 0);
    const limit = Math.max(1, Math.min(500, Number(c.req.query('limit') ?? 100)));
    const { items, next_since_id } = tailNews(
      env,
      Number.isFinite(sinceId) ? sinceId : 0,
      limit,
      { sessionId },
    );
    return c.json({ items, next_since_id });
  });

  return app;
}
