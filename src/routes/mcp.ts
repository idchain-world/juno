import { Hono } from 'hono';
import type { Env } from '../env.js';

// HTTP MCP shim. JSON-RPC 2.0 over a single POST endpoint.
//
// Exposes three tools, all public (no Bearer). All session-scoped writes
// and reads require a `session_id` the caller already owns — the same
// contract as the REST /talk and /news public endpoints. Calls relay
// through the already-running REST routes via localhost, so any hardening
// (rate-limit, body-size, budget, inbox, session validation) applies to
// MCP callers for free.
//
// Tools:
//   talk      — sync chat, mints a session on first turn, threads on follow-ups
//   news      — append an item to the caller's session news (session_id required)
//   get_news  — list items tagged to the caller's session_id only
//
// No tool ever exposes another session's data or grants operator-level
// visibility. Operators who want to see everything must reach the /inbox
// + operator /news routes directly via SSH tunnel.

type JsonRpcId = number | string | null;

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

const PROTOCOL_VERSION = '2024-11-05';

function rpcResult(id: JsonRpcId | undefined, result: unknown) {
  return { jsonrpc: '2.0' as const, id: id ?? null, result };
}

function rpcError(id: JsonRpcId | undefined, code: number, message: string, data?: unknown) {
  return { jsonrpc: '2.0' as const, id: id ?? null, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

function toolsList(env: Env) {
  return {
    tools: [
      {
        name: 'talk',
        description:
          `Send a question to ${env.agentName}. Synchronous — returns the model reply in the same call. ` +
          'Pass session_id from a previous reply to continue a conversation; omit to start a new one. ' +
          'Every call is appended to the inbox for human review.',
        inputSchema: {
          type: 'object',
          properties: {
            message: { type: 'string', description: 'Your question or message. Required.' },
            from: { type: 'string', description: 'Client-declared sender. Optional, not verified.' },
            session_id: {
              type: 'string',
              description:
                'Optional. Server-minted UUID returned from a prior call. Include on follow-up turns to thread them; omit to start a fresh session.',
            },
          },
          required: ['message'],
        },
      },
      {
        name: 'news',
        description:
          `Append a news item to ${env.agentName}'s inbox, tagged to your session. ` +
          'Fire-and-forget; returns only an id + timestamp. A valid session_id is required — ' +
          'you must have already called `talk` at least once on the same session to have one. ' +
          'Items are scoped to your session: other callers cannot read what you posted.',
        inputSchema: {
          type: 'object',
          properties: {
            session_id: {
              type: 'string',
              description: 'UUID from a prior `talk` call. Required.',
            },
            from: { type: 'string', description: 'Sender identifier. Required.' },
            message: { type: 'string', description: 'News message. Required.' },
            type: { type: 'string', description: "Optional. Defaults to 'notify'." },
            data: { type: 'object', description: 'Optional free-form payload.' },
          },
          required: ['session_id', 'from', 'message'],
        },
      },
      {
        name: 'get_news',
        description:
          `Read items from ${env.agentName}'s news feed that are tagged to your session. ` +
          'Returns only your own items — you cannot read other callers\' news. ' +
          'Unknown session_id returns an empty list (not an error) so callers cannot probe for session existence.',
        inputSchema: {
          type: 'object',
          properties: {
            session_id: {
              type: 'string',
              description: 'UUID from a prior `talk` call. Required.',
            },
            since_id: {
              type: 'number',
              description: 'Optional. Return only items with id > since_id. Omit or 0 for all.',
            },
            limit: {
              type: 'number',
              description: 'Optional. Max items to return, 1..500. Defaults to 100.',
            },
          },
          required: ['session_id'],
        },
      },
    ],
  };
}

async function relayPost(env: Env, path: '/talk' | '/news', body: unknown) {
  // Loopback to the public listener. No egress.
  const url = `http://127.0.0.1:${env.port}${path}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  return { ok: resp.ok, status: resp.status, body: parsed };
}

async function relayGet(env: Env, path: string) {
  const url = `http://127.0.0.1:${env.port}${path}`;
  const resp = await fetch(url, { method: 'GET' });
  const text = await resp.text();
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  return { ok: resp.ok, status: resp.status, body: parsed };
}

function toolResult(content: unknown, isError = false) {
  return {
    content: [
      {
        type: 'text' as const,
        text: typeof content === 'string' ? content : JSON.stringify(content, null, 2),
      },
    ],
    isError,
  };
}

export function mcpRoutes(env: Env): Hono {
  const app = new Hono();

  app.post('/mcp', async (c) => {
    let req: JsonRpcRequest;
    try {
      req = (await c.req.json()) as JsonRpcRequest;
    } catch {
      return c.json(rpcError(null, -32700, 'Parse error'), 400);
    }
    if (req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
      return c.json(rpcError(req.id, -32600, 'Invalid Request'), 400);
    }

    switch (req.method) {
      case 'initialize':
        return c.json(rpcResult(req.id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: env.agentName, version: env.version },
        }));

      case 'tools/list':
        return c.json(rpcResult(req.id, toolsList(env)));

      case 'tools/call': {
        const params = req.params ?? {};
        const name = params.name as string | undefined;
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        if (!name) return c.json(rpcError(req.id, -32602, 'Missing tool name'));

        if (name === 'talk') {
          const message = typeof args.message === 'string' ? args.message : '';
          const from = typeof args.from === 'string' ? args.from : undefined;
          const session_id = typeof args.session_id === 'string' && args.session_id.trim()
            ? args.session_id.trim()
            : undefined;
          if (!message.trim()) {
            return c.json(rpcResult(req.id, toolResult({ error: 'missing_message' }, true)));
          }
          const relayed = await relayPost(env, '/talk', { message, from, session_id });
          return c.json(rpcResult(req.id, toolResult(relayed.body, !relayed.ok)));
        }

        if (name === 'news') {
          const session_id = typeof args.session_id === 'string' ? args.session_id.trim() : '';
          const from = typeof args.from === 'string' ? args.from.trim() : '';
          const message = typeof args.message === 'string' ? args.message.trim() : '';
          const type = typeof args.type === 'string' ? args.type : undefined;
          const data = args.data;
          if (!session_id) return c.json(rpcResult(req.id, toolResult({ error: 'missing_session_id' }, true)));
          if (!from) return c.json(rpcResult(req.id, toolResult({ error: 'missing_from' }, true)));
          if (!message) return c.json(rpcResult(req.id, toolResult({ error: 'missing_message' }, true)));
          const relayed = await relayPost(env, '/news', { session_id, from, message, type, data });
          return c.json(rpcResult(req.id, toolResult(relayed.body, !relayed.ok)));
        }

        if (name === 'get_news') {
          const session_id = typeof args.session_id === 'string' ? args.session_id.trim() : '';
          if (!session_id) return c.json(rpcResult(req.id, toolResult({ error: 'missing_session_id' }, true)));
          const sinceId = typeof args.since_id === 'number' && Number.isFinite(args.since_id)
            ? args.since_id
            : 0;
          const limit = typeof args.limit === 'number' && Number.isFinite(args.limit)
            ? Math.max(1, Math.min(500, args.limit))
            : 100;
          const qs = `?session_id=${encodeURIComponent(session_id)}&since_id=${sinceId}&limit=${limit}`;
          const relayed = await relayGet(env, `/news${qs}`);
          return c.json(rpcResult(req.id, toolResult(relayed.body, !relayed.ok)));
        }

        return c.json(rpcError(req.id, -32601, `Unknown tool: ${name}`));
      }

      default:
        return c.json(rpcError(req.id, -32601, `Method not found: ${req.method}`));
    }
  });

  return app;
}
