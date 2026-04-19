import { Hono } from 'hono';
import type { Env } from '../env.js';

// HTTP MCP shim. JSON-RPC 2.0 over a single POST endpoint.
// Exposes exactly one tool: `talk`. Calls relay through the already-running
// /talk HTTP route via localhost — they do NOT import openrouter/inbox/budget
// modules. That keeps the MCP boundary thin: any hardening we add to /talk
// (rate-limit, body-size, budget, inbox) automatically applies to MCP callers
// too.
//
// No `news` tool and no inbox read is ever exposed via MCP. That lets us
// run /mcp on the public listener without fear of random callers writing
// spam into the inbox. Operators who need to post news should reach /news
// directly on the operator listener via SSH tunnel.

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
    ],
  };
}

async function relay(env: Env, body: unknown) {
  // Loopback to the public listener's /talk. No egress.
  const url = `http://127.0.0.1:${env.port}/talk`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await resp.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }
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

  // MCP is public. The only tool exposed is `talk`, which matches the
  // public surface of /talk — same rate limit and budget apply. The `news`
  // tool is intentionally not exposed here so random callers cannot write
  // to the inbox. Operators who need to push news should use the operator
  // listener's /news endpoint directly (SSH-tunneled, Bearer-gated).
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
          serverInfo: { name: env.agentName, version: '0.1.0' },
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
          const relayed = await relay(env, { message, from, session_id });
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
