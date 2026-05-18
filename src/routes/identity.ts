import { Hono } from 'hono';
import fs from 'node:fs';
import type { Env } from '../env.js';

/**
 * GET /identity returns the operator-delivered identity file. The file is
 * re-read on each request, so delivery updates are picked up without a restart.
 */
export function identityRoutes(env: Env): Hono {
  const app = new Hono();

  app.get('/identity', (c) => {
    let raw: string;
    try {
      raw = fs.readFileSync(env.identityPath, 'utf8');
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        return c.json(
          {
            error: 'identity_not_provisioned',
            message: 'Identity has not been delivered to this host yet.',
          },
          404,
        );
      }
      return c.json({ error: 'identity_unreadable' }, 500);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return c.json({ error: 'identity_corrupt' }, 500);
    }
    return c.json(parsed);
  });

  return app;
}
