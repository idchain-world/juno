import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeEnv } from '../../tests/helpers/makeEnv.js';
import { fetchSessionContext } from './session-context.js';

function env() {
  return makeEnv({
    mcpEndpointUrl: 'https://dappa.example/api/internal/juno/mcp',
    mcpServiceToken: 'service-token',
    mcpTimeoutMs: 50,
  });
}

describe('fetchSessionContext', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null on 404 graceful fallback', async () => {
    const fetchMock = vi.fn(async () => new Response('not found', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchSessionContext(env(), { context: { tokenId: '7' }, tokenId: '7' })).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns null on network error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('socket closed');
    }));

    await expect(fetchSessionContext(env(), { context: { tokenId: '7' }, tokenId: '7' })).resolves.toBeNull();
  });

  it('returns parsed result on 200 and sends service auth plus context', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ sources: [{ key: 'persona', content: 'Be precise.' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchSessionContext(env(), {
      context: { projectSlug: 'normies', tokenId: '7' },
      tokenId: '7',
    });

    expect(result).toEqual({ sources: [{ key: 'persona', content: 'Be precise.' }] });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://dappa.example/api/internal/juno/session-context');
    expect(init.headers).toMatchObject({
      authorization: 'Bearer service-token',
      'x-juno-context': JSON.stringify({ projectSlug: 'normies', tokenId: '7' }),
    });
  });

  it('sends explicit x-dappa-* identity headers alongside the legacy x-juno-context blob', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ sources: [{ key: 'persona', content: 'Be precise.' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const context = {
      projectSlug: 'normies',
      chainId: 1,
      tokenContract: '0xabc0000000000000000000000000000000000000',
      tokenId: '7',
      requestId: 'req-1',
      workerId: 'worker-1',
    };
    await fetchSessionContext(env(), { context, tokenId: '7' });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toMatchObject({
      authorization: 'Bearer service-token',
      // Back-compat: the JSON blob is still sent unchanged.
      'x-juno-context': JSON.stringify(context),
      // New: each identity field is also an explicit, individually-named header.
      'x-dappa-project-slug': 'normies',
      'x-dappa-chain-id': '1',
      'x-dappa-token-contract': '0xabc0000000000000000000000000000000000000',
      'x-dappa-token-id': '7',
      'x-dappa-request-id': 'req-1',
      'x-dappa-juno-worker-id': 'worker-1',
    });
  });

  it('omits x-dappa-* headers for identity fields that are absent', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ sources: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await fetchSessionContext(env(), { context: { tokenId: '7' }, tokenId: '7' });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['x-dappa-token-id']).toBe('7');
    expect(headers['x-dappa-project-slug']).toBeUndefined();
    expect(headers['x-dappa-chain-id']).toBeUndefined();
  });

  it('does not forward studio override header when absent', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ sources: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await fetchSessionContext(env(), { context: { tokenId: '7' }, tokenId: '7' });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).not.toMatchObject({ 'x-dappa-studio-override': expect.any(String) });
  });

  it('forwards studio override header when override is drafts', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ sources: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await fetchSessionContext(env(), { context: { tokenId: '7' }, tokenId: '7' }, 'drafts');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toMatchObject({ 'x-dappa-studio-override': 'drafts' });
  });

  it('does not forward studio override header for non-drafts values', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ sources: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await fetchSessionContext(env(), { context: { tokenId: '7' }, tokenId: '7' }, 'published');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).not.toMatchObject({ 'x-dappa-studio-override': expect.any(String) });
  });

  it('returns null on malformed response shape', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ sources: [{ key: 'missing content' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    await expect(fetchSessionContext(env(), { context: { tokenId: '7' }, tokenId: '7' })).resolves.toBeNull();
  });
});
