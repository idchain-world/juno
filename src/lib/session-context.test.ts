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
