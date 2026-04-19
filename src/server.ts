import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { loadEnv } from './env.js';
import { wellknownRoutes } from './routes/wellknown.js';
import { talkRoutes } from './routes/talk.js';
import { newsRoutes } from './routes/news.js';
import { publicNewsRoutes } from './routes/public-news.js';
import { inboxRoutes } from './routes/inbox.js';
import { mcpRoutes } from './routes/mcp.js';
import { healthRoutes } from './routes/health.js';
import { identityRoutes } from './routes/identity.js';
import { loadManifest } from './lib/knowledge.js';
import { purgeOldArtifacts } from './lib/tool-truncate.js';
import { createSessionStore } from './lib/sessions.js';

const env = loadEnv();

// Hard-fail at startup if the knowledge dir has any rejectable file. We'd
// rather crash on boot than serve partially-indexed or attacker-controlled
// knowledge to callers.
let knowledge;
try {
  knowledge = loadManifest(env.knowledgeDir);
  console.log(`[public-agent] knowledge manifest: ${knowledge.entries.size} file(s) from ${knowledge.root}`);
} catch (err) {
  console.error(`[public-agent] knowledge load failed: ${(err as Error).message}`);
  process.exit(1);
}

try {
  const swept = purgeOldArtifacts(env.dataDir);
  if (swept.removed > 0 || swept.kept > 0) {
    console.log(`[public-agent] tool-artifacts purge: removed=${swept.removed} kept=${swept.kept}`);
  }
} catch (err) {
  console.error('[public-agent] tool-artifacts purge failed:', err);
}

const TALK_BODY_LIMIT = 64 * 1024;
const NEWS_BODY_LIMIT = 16 * 1024;
const MCP_BODY_LIMIT = 64 * 1024;

const oversize = (maxSize: number) =>
  bodyLimit({
    maxSize,
    onError: (c) =>
      c.json({ error: 'payload_too_large', limit: maxSize }, 413),
  });

// Single session store shared by /talk and the session-scoped /news.
// Disk-backed under <dataDir>/sessions/ so a restart does not nuke callers'
// conversations. Default idle TTL is 24h (SESSION_IDLE_MINUTES).
const sessions = createSessionStore(env);

// ── Public listener: internet-reachable surfaces ──
// /talk  — sync chat, rate-limited. Public by default (PROTECT_TALK to gate).
// /news  — session-scoped; read/write your own news by session_id only.
// /mcp   — public, JSON-RPC, exposes only the `talk` tool.
// /health, /identity, /.well-known/* — discovery + status, always public.
const publicApp = new Hono();
publicApp.on('POST', '/talk', oversize(TALK_BODY_LIMIT));
publicApp.on('POST', '/news', oversize(NEWS_BODY_LIMIT));
publicApp.on('POST', '/mcp', oversize(MCP_BODY_LIMIT));
publicApp.route('/', wellknownRoutes(env));
publicApp.route('/', healthRoutes(env));
publicApp.route('/', identityRoutes(env));
publicApp.route('/', talkRoutes(env, knowledge, sessions));
publicApp.route('/', publicNewsRoutes(env, sessions));
publicApp.route('/', mcpRoutes(env));
publicApp.all('*', (c) => c.json({ error: 'not_found', path: c.req.path }, 404));

// ── Operator listener: loopback-only surfaces (/inbox, /news, /mcp) ──
const operatorApp = new Hono();
operatorApp.on('POST', '/news', oversize(NEWS_BODY_LIMIT));
operatorApp.on('POST', '/mcp', oversize(MCP_BODY_LIMIT));
operatorApp.route('/', newsRoutes(env));
operatorApp.route('/', inboxRoutes(env));
operatorApp.route('/', mcpRoutes(env));
operatorApp.all('*', (c) => c.json({ error: 'not_found', path: c.req.path }, 404));

// Emit the dev-mode warning early if auth key is absent and the escape hatch is on.
if (!env.authKey && env.allowPublicUnauthenticated) {
  process.stderr.write(
    '[public-agent] WARNING: ALLOW_PUBLIC_UNAUTHENTICATED=true — operator endpoints are open. Do not use in production.\n',
  );
}

if (env.operatorHost !== '127.0.0.1' && env.operatorHost !== 'localhost') {
  process.stderr.write(
    `[public-agent] WARNING: operator endpoints bound to ${env.operatorHost}:${env.operatorPort} — not loopback. ` +
      'Operator surfaces (/inbox, /news, /mcp) must be reached only over SSH tunnel in production. ' +
      'Set OPERATOR_HOST=127.0.0.1 or front with a reverse proxy that does not expose these routes.\n',
  );
}

const authStatus = env.authKey
  ? 'keyed'
  : env.allowPublicUnauthenticated
    ? 'open-dev'
    : 'closed';

serve({ fetch: publicApp.fetch, port: env.port, hostname: env.publicHost }, (info) => {
  console.log(
    `[public-agent] ${env.agentName} public endpoints on ${env.publicHost}:${info.port} ` +
      `(model=${env.openRouterModel}, version=${env.version})`,
  );
});

serve({ fetch: operatorApp.fetch, port: env.operatorPort, hostname: env.operatorHost }, (info) => {
  console.log(
    `[public-agent] operator endpoints bound to ${env.operatorHost}:${info.port} (auth=${authStatus})`,
  );
});
