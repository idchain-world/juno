import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeEnv } from './helpers/makeEnv.js';
import {
  createRequestKnowledgeProvider,
  executeKnowledgeToolWithProvider,
  loadManifest,
} from '../src/lib/knowledge.js';

function localManifest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'juno-knowledge-'));
  fs.writeFileSync(path.join(dir, 'fallback.md'), '# Fallback\n\nLocal fallback content.');
  return loadManifest(dir);
}

describe('remote HTTP knowledge provider', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('posts Dappa query shape with token context and bearer auth', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          documents: [{ id: 'normies-lore', title: 'Normies Lore', content: 'Remote Normie context', score: 0.9 }],
          answerHints: [],
          revision: 'test',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const env = makeEnv({
      knowledgeProvider: 'remote-http',
      knowledgeApiUrl: 'https://dappa.example',
      knowledgeApiAuthMode: 'bearer',
      knowledgeApiAuthToken: 'secret-token',
      dappaProjectSlug: 'normies',
    });
    const provider = createRequestKnowledgeProvider({
      env,
      localManifest: localManifest(),
      context: { chainId: 1, tokenContract: '0xabc', tokenId: '9152' },
      conversation: [{ role: 'user', content: 'What is this Normie?' }],
    });

    const result = await executeKnowledgeToolWithProvider(
      provider,
      'search_knowledge',
      JSON.stringify({ query: 'Normie' }),
      { dataDir: os.tmpdir() },
    );

    expect(result.log.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://dappa.example/api/projects/normies/knowledge/query');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer secret-token');
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      query: 'Normie',
      context: { chainId: 1, tokenContract: '0xabc', tokenId: '9152', projectSlug: 'normies' },
      topK: 5,
    });
  });

  it('uses service auth header and reads cached remote documents', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ documents: [{ id: 'doc-one', title: 'Doc One', content: 'Full remote body' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    const provider = createRequestKnowledgeProvider({
      env: makeEnv({
        knowledgeProvider: 'remote-http',
        knowledgeApiUrl: 'https://dappa.example/api/projects/normies/knowledge/query',
        knowledgeApiAuthMode: 'service',
        knowledgeApiAuthToken: 'svc',
      }),
      localManifest: localManifest(),
      context: {},
      conversation: [],
    });

    await provider.search('doc');
    const read = await provider.read('doc-one.md');
    expect(read?.content).toBe('Full remote body');
    const init = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)['x-dappa-knowledge-token']).toBe('svc');
  });

  it('times out remote retrieval', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise((_resolve, reject) => {
            setTimeout(() => reject(new DOMException('aborted', 'AbortError')), 20);
          }),
      ),
    );
    const provider = createRequestKnowledgeProvider({
      env: makeEnv({
        knowledgeProvider: 'remote-http',
        knowledgeApiUrl: 'https://dappa.example',
        knowledgeApiTimeoutMs: 5,
        dappaProjectSlug: 'normies',
      }),
      localManifest: localManifest(),
      context: {},
      conversation: [],
    });

    await expect(provider.search('slow')).rejects.toThrow(/timeout/);
  });

  it('falls back to local knowledge when enabled', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 503 })));
    const provider = createRequestKnowledgeProvider({
      env: makeEnv({
        knowledgeProvider: 'remote-http',
        knowledgeApiUrl: 'https://dappa.example',
        knowledgeRemoteFallbackLocal: true,
        dappaProjectSlug: 'normies',
      }),
      localManifest: localManifest(),
      context: {},
      conversation: [],
    });

    const hits = await provider.search('fallback');
    expect(hits[0]?.file_id).toBe('fallback.md');
  });
});
