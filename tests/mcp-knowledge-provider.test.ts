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
    dappaMcpEndpointUrl: 'https://dappa.example/api/internal/juno/mcp',
    dappaMcpAllowedOrigin: 'https://dappa.example',
    dappaJunoMcpServiceToken: 'service-token',
    dappaProjectSlug: 'normies',
    dappaChainId: '1',
    dappaTokenContract: '0xabc',
    dappaTokenId: '9152',
    dappaJunoWorkerId: 'worker-a',
    ...overrides,
  });
}

describe('Dappa MCP knowledge provider', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists dynamic MCP tools and injects service and token identity headers on tool call', async () => {
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
      context: { chainId: 8453, tokenContract: '0xdef', tokenId: '7', projectSlug: 'override-slug' },
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
    expect(url).toBe('https://dappa.example/api/internal/juno/mcp');
    expect(init.headers).toMatchObject({
      authorization: 'Bearer service-token',
      'x-dappa-project-slug': 'override-slug',
      'x-dappa-chain-id': '8453',
      'x-dappa-token-contract': '0xdef',
      'x-dappa-token-id': '7',
      'x-dappa-juno-worker-id': 'worker-a',
    });
    expect(JSON.parse(init.body as string).params).toEqual({
      name: 'custom_project_tool',
      arguments: { depth: 2 },
    });
  });

  it('rejects a non-whitelisted MCP endpoint URL', () => {
    expect(() =>
      createRequestKnowledgeProvider({
        env: mcpEnv({ dappaMcpEndpointUrl: 'https://evil.example/api/internal/juno/mcp' }),
        localManifest: localManifest(),
        context: {},
        conversation: [],
      }),
    ).toThrow(/not whitelisted/);
  });
});
