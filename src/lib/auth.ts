import type { MiddlewareHandler } from 'hono';
import type { Env } from '../env.js';

// Log the dev-mode warning once per process start, not per request.
let _devWarnEmitted = false;
function emitDevWarning(): void {
  if (_devWarnEmitted) return;
  _devWarnEmitted = true;
  process.stderr.write(
    '[public-agent] WARNING: ALLOW_PUBLIC_UNAUTHENTICATED=true — operator endpoints are open. Do not use in production.\n',
  );
}

/**
 * requireAuth — fail-closed when auth key is unset.
 *
 * - authKey set: require matching Bearer token.
 * - authKey unset + allowPublicUnauthenticated=true: pass through (dev mode;
 *   emits a one-time stderr warning at startup).
 * - authKey unset + allowPublicUnauthenticated=false: always 401.
 *
 * Apply to /inbox, /news, /mcp. NOT to /talk (use requireAuthOrPublicTalk).
 */
export function requireAuth(env: Env): MiddlewareHandler {
  if (env.authKey !== null) {
    const expected = env.authKey;
    return async (c, next) => {
      const header = c.req.header('authorization') || '';
      const m = /^Bearer\s+(.+)$/i.exec(header);
      if (!m || m[1]!.trim() !== expected) {
        return c.json({ error: 'unauthorized' }, 401);
      }
      await next();
    };
  }

  if (env.allowPublicUnauthenticated) {
    emitDevWarning();
    return async (_c, next) => {
      await next();
    };
  }

  // No key and no dev escape: fail closed on every call.
  return async (c) => {
    return c.json(
      {
        error: 'auth_required',
        message: 'Set PUBLIC_AGENT_AUTH_KEY or ALLOW_PUBLIC_UNAUTHENTICATED=true',
      },
      401,
    );
  };
}

/**
 * requireAuthOrPublicTalk — /talk is the public product surface.
 *
 * Default behaviour: pass through regardless of authKey. Rate limit and the
 * daily token budget are the real controls that protect upstream OpenRouter
 * cost.
 *
 * Intranet / private deployments can set PROTECT_TALK=true to gate /talk
 * with the same Bearer token as operator endpoints. Only honoured when
 * authKey is also set (otherwise there is nothing to check against).
 */
export function requireAuthOrPublicTalk(env: Env): MiddlewareHandler {
  if (env.authKey !== null && env.protectTalk === true) {
    const expected = env.authKey;
    return async (c, next) => {
      const header = c.req.header('authorization') || '';
      const m = /^Bearer\s+(.+)$/i.exec(header);
      if (!m || m[1]!.trim() !== expected) {
        return c.json({ error: 'unauthorized' }, 401);
      }
      await next();
    };
  }

  // Default: /talk is open. Operator endpoints stay gated by requireAuth.
  return async (_c, next) => {
    await next();
  };
}
