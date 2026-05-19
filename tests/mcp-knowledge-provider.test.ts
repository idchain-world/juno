import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeEnv } from './helpers/makeEnv.js';
import { createRequestKnowledgeProvider, loadManifest } from '../src/lib/knowledge.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function localManifest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'juno-mcp-knowledge-'));
  fs.writeFileSync(path.join(dir, 'fallback.md'), '# Fallback\n\nLocal fallback content.');
  return loadManifest(dir);
}

function mcpEnv(overrides = {}) {
  return makeEnv({
    knowledgeProvider: 'mcp',
    mcpEndpointUrl: 'https://knowledge.example/api/internal/juno/mcp',
    mcpAllowedOrigin: 'https://knowledge.example',
    mcpServiceToken: 'service-token',
    requestContext: {
      tenantSlug: 'example-tenant',
      resourceGroup: 'alpha',
      resourceId: '9152',
      workerId: 'worker-a',
    },
    ...overrides,
  });
}

describe('MCP knowledge provider', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists dynamic MCP tools and forwards service auth plus opaque context on tool call', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      if (body.method === 'initialize') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2024-11-05' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (body.method === 'notifications/initialized') {
        return new Response(null, { status: 204 });
      }
      if (body.method === 'tools/list') {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              tools: [
                {
                  name: 'get_token_context',
                  description: 'Get token context',
                  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
                },
                {
                  name: 'custom_project_tool',
                  description: 'Dynamic project tool',
                  inputSchema: {
                    type: 'object',
                    properties: { depth: { type: 'number' } },
                    required: ['depth'],
                    additionalProperties: false,
                  },
                },
              ],
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (body.method === 'tools/call') {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: { content: [{ type: 'text', text: 'Dynamic result' }] },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('unexpected', { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = createRequestKnowledgeProvider({
      env: mcpEnv(),
      localManifest: localManifest(),
      context: { resourceGroup: 'beta', resourceId: '7', tenantSlug: 'override-tenant' },
      conversation: [],
    });

    const tools = await provider.toolDefinitions?.();
    expect(tools?.map((tool) => tool.function.name)).toEqual(['get_token_context', 'custom_project_tool']);

    const directResult = await provider.executeTool?.('custom_project_tool', JSON.stringify({ depth: 2 }), {
      dataDir: os.tmpdir(),
    });

    expect(directResult?.content).toBe('Dynamic result');
    const call = fetchMock.mock.calls.find(([, init]) => JSON.parse(init.body as string).method === 'tools/call');
    expect(call).toBeTruthy();
    const [url, init] = call as [string, RequestInit];
    expect(url).toBe('https://knowledge.example/api/internal/juno/mcp');
    expect(init.headers).toMatchObject({
      authorization: 'Bearer service-token',
      'x-juno-context': JSON.stringify({
        tenantSlug: 'override-tenant',
        resourceGroup: 'beta',
        resourceId: '7',
        workerId: 'worker-a',
      }),
    });
    expect(JSON.parse(init.body as string).params).toEqual({
      name: 'custom_project_tool',
      arguments: { depth: 2 },
      context: {
        tenantSlug: 'override-tenant',
        resourceGroup: 'beta',
        resourceId: '7',
        workerId: 'worker-a',
      },
    });
  });

  it('keeps nested/oversized context out of the x-juno-context header but in the tools/call body', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      if (body.method === 'initialize') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {} }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (body.method === 'notifications/initialized') {
        return new Response(null, { status: 204 });
      }
      if (body.method === 'tools/list') {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              tools: [
                {
                  name: 't',
                  description: 'd',
                  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
                },
              ],
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (body.method === 'tools/call') {
        return new Response(
          JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'ok' }] } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('unexpected', { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);

    // An inline base64 image is the real-world bloat that overflowed the
    // proxy header limit (HTTP 494).
    const hugeImage = `data:image/svg+xml;base64,${'A'.repeat(20_000)}`;
    const provider = createRequestKnowledgeProvider({
      env: mcpEnv({ requestContext: {} }),
      localManifest: localManifest(),
      context: {
        tenantSlug: 'big-tenant',
        resourceId: '1008',
        nft: { image: hugeImage, name: 'Normie #1008' },
        oversizedField: hugeImage,
      },
      conversation: [],
    });

    await provider.executeTool?.('t', '{}', { dataDir: os.tmpdir() });

    // Every MCP request header is scalars-only: no nested object, no oversized
    // string. So it stays small regardless of how rich the context is.
    for (const [, init] of fetchMock.mock.calls) {
      const header = (init.headers as Record<string, string>)['x-juno-context'];
      expect(JSON.parse(header)).toEqual({ tenantSlug: 'big-tenant', resourceId: '1008' });
      expect(header.length).toBeLessThan(1024);
    }

    // The full context — nested nft + oversized field — still rides in the
    // tools/call JSON-RPC body, which has no size limit.
    const call = fetchMock.mock.calls.find(([, init]) => JSON.parse(init.body as string).method === 'tools/call');
    const params = JSON.parse((call as [string, RequestInit])[1].body as string).params;
    expect(params.context.nft.image).toBe(hugeImage);
    expect(params.context.oversizedField).toBe(hugeImage);
  });

  it('rejects a non-whitelisted MCP endpoint URL', () => {
    expect(() =>
      createRequestKnowledgeProvider({
        env: mcpEnv({ mcpEndpointUrl: 'https://evil.example/api/internal/juno/mcp' }),
        localManifest: localManifest(),
        context: {},
        conversation: [],
      }),
    ).toThrow(/not whitelisted/);
  });
});
