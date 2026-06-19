import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSessionStore } from '../src/lib/sessions.js';
import { loadManifest } from '../src/lib/knowledge.js';
import { talkRoutes } from '../src/routes/talk.js';
import { makeEnv } from './helpers/makeEnv.js';
import { req } from './helpers/httpClient.js';

// RESTAP 0.1.3 Sessions conformance for Juno POST /talk.
function makeTalkHarness(envOverrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'juno-talk-session-'));
  const dataDir = path.join(root, 'data');
  const knowledgeDir = path.join(root, 'knowledge');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(knowledgeDir, { recursive: true });
  fs.writeFileSync(path.join(knowledgeDir, 'topic.md'), '# Topic\n\nTest content.');

  const env = makeEnv({
    dataDir,
    knowledgeDir,
    trustedProxy: true,
    maxGuardTokens: 256,
    maxReplyTokens: 1024,
    ...envOverrides,
  });
  const app = talkRoutes(env, loadManifest(knowledgeDir), createSessionStore(env));
  return { app, env, root };
}

function mockOpenRouter(guardClassification: 'allow' | 'refuse' = 'allow') {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href.includes('/api/internal/juno/session-context')) {
        return new Response('not found', { status: 404 });
      }
      const body = JSON.parse(String(init?.body ?? '{}'));
      if (body.response_format) {
        const violationType = guardClassification === 'allow' ? 'none' : 'jailbreak';
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    classification: guardClassification,
                    violation_type: violationType,
                    cwe_codes: [],
                    reasoning: `${guardClassification} test verdict`,
                  }),
                },
              },
            ],
            usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
            model: 'guard-test-model',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 7, completion_tokens: 1, total_tokens: 8 },
          model: 'main-test-model',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }),
  );
}

const IP = { 'x-forwarded-for': '203.0.113.10' };

describe('/talk RESTAP 0.1.3 session_id conformance', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects a malformed session_id with 400 {"error":"invalid_session_id"} (JSON)', async () => {
    const { app, root } = makeTalkHarness();
    mockOpenRouter();
    try {
      const res = await req(app, 'POST', '/talk', {
        headers: IP,
        body: { message: 'hi', session_id: 'too-short' }, // < 16 chars
      });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'invalid_session_id' });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects disallowed characters in session_id', async () => {
    const { app, root } = makeTalkHarness();
    mockOpenRouter();
    try {
      const res = await req(app, 'POST', '/talk', {
        headers: IP,
        body: { message: 'hi', session_id: 'has spaces and/slashes!!' },
      });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'invalid_session_id' });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns the same invalid_session_id error for streaming requests (Accept: text/event-stream)', async () => {
    const { app, root } = makeTalkHarness();
    mockOpenRouter();
    try {
      const res = await req(app, 'POST', '/talk', {
        headers: { ...IP, accept: 'text/event-stream' },
        body: { message: 'hi', session_id: 'bad id' },
      });
      // Validation happens before any SSE branching: a 400 JSON error, not a stream.
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'invalid_session_id' });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts a valid non-UUID session_id (request proceeds, not rejected)', async () => {
    const { app, root } = makeTalkHarness();
    mockOpenRouter();
    try {
      const sid = 'Sess.ion_id-0123456789'; // matches ^[A-Za-z0-9._-]{16,128}$
      const res = await req(app, 'POST', '/talk', {
        headers: IP,
        body: { message: 'hi', session_id: sid },
      });
      // Valid format must NOT be rejected. (Whether a brand-new id is adopted or
      // a fresh session is minted is sessions-store behavior, out of this slice's
      // scope; the conformance point here is that a well-formed id is accepted.)
      expect(res.status).toBe(200);
      expect((res.body as { session_id?: string }).session_id).toMatch(/^[A-Za-z0-9._-]{16,128}$/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('continues an existing session when its id is supplied on a later turn', async () => {
    const { app, root } = makeTalkHarness();
    mockOpenRouter();
    try {
      const first = await req(app, 'POST', '/talk', { headers: IP, body: { message: 'first' } });
      const sid = (first.body as { session_id: string }).session_id;
      const second = await req(app, 'POST', '/talk', {
        headers: IP,
        body: { message: 'second', session_id: sid },
      });
      expect(second.status).toBe(200);
      expect((second.body as { session_id: string }).session_id).toBe(sid);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('mints a UUIDv4 session_id when session_id is absent', async () => {
    const { app, root } = makeTalkHarness();
    mockOpenRouter();
    try {
      const res = await req(app, 'POST', '/talk', { headers: IP, body: { message: 'hi' } });
      expect(res.status).toBe(200);
      const minted = (res.body as { session_id: string }).session_id;
      expect(minted).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('emits session_id on the SSE done frame (buffered refuse path)', async () => {
    const { app, root } = makeTalkHarness();
    mockOpenRouter('refuse');
    try {
      const res = await req(app, 'POST', '/talk', {
        headers: { ...IP, accept: 'text/event-stream' },
        body: { message: 'blocked' },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      // done frame must carry session_id per the 0.1.3 contract.
      expect(res.text).toMatch(/event: done\ndata: \{"session_id":"[^"]+"\}/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
