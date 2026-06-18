import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSessionStore } from '../src/lib/sessions.js';
import { loadManifest } from '../src/lib/knowledge.js';
import { talkRoutes } from '../src/routes/talk.js';
import { makeEnv } from './helpers/makeEnv.js';
import { req } from './helpers/httpClient.js';

// Harness mirrors tests/talk-system-prompt.test.ts so message ordering through
// the main LLM call can be asserted without a live OpenRouter backend.
function makeTalkHarness(envOverrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'juno-talk-history-'));
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

function mockOpenRouter(calls: unknown[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href.includes('/api/internal/juno/session-context')) {
        return new Response('not found', { status: 404 });
      }
      const body = JSON.parse(String(init?.body ?? '{}'));
      calls.push(body);
      if (body.response_format) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    classification: 'allow',
                    violation_type: 'none',
                    cwe_codes: [],
                    reasoning: 'allow test verdict',
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

async function postTalk(body: Record<string, unknown>, calls: unknown[]) {
  const { app, root } = makeTalkHarness();
  mockOpenRouter(calls);
  try {
    return await req(app, 'POST', '/talk', {
      headers: { 'x-forwarded-for': '203.0.113.10' },
      body,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function guardCall(calls: unknown[]) {
  return calls.find((call) => Boolean((call as { response_format?: unknown }).response_format)) as {
    messages: Array<{ role: string; content: string }>;
  };
}

function mainCall(calls: unknown[]) {
  return calls.find((call) => !Boolean((call as { response_format?: unknown }).response_format)) as {
    messages: Array<{ role: string; content: string }>;
  };
}

describe('/talk caller-provided history', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prepends history turns before the new user message in chronological order', async () => {
    const calls: unknown[] = [];
    const res = await postTalk(
      {
        message: 'and now?',
        history: [
          { role: 'user', content: 'first question' },
          { role: 'assistant', content: 'first answer' },
        ],
      },
      calls,
    );

    expect(res.status).toBe(200);
    const messages = mainCall(calls).messages;
    expect(messages[0]?.role).toBe('system');
    expect(messages.slice(1)).toEqual([
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'and now?' },
    ]);
  });

  it('keeps current behavior when history is absent', async () => {
    const calls: unknown[] = [];
    const res = await postTalk({ message: 'hello without history' }, calls);

    expect(res.status).toBe(200);
    const messages = mainCall(calls).messages;
    expect(messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(messages[1]).toEqual({ role: 'user', content: 'hello without history' });
  });

  it('tolerates an empty history array as a no-op', async () => {
    const calls: unknown[] = [];
    const res = await postTalk({ message: 'hi', history: [] }, calls);

    expect(res.status).toBe(200);
    const messages = mainCall(calls).messages;
    expect(messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(messages[1]).toEqual({ role: 'user', content: 'hi' });
  });

  it('drops whitespace-only history turns after trimming', async () => {
    const calls: unknown[] = [];
    const res = await postTalk(
      {
        message: 'current',
        history: [
          { role: 'user', content: '   ' },
          { role: 'assistant', content: '  kept reply  ' },
        ],
      },
      calls,
    );

    expect(res.status).toBe(200);
    const messages = mainCall(calls).messages;
    expect(messages.slice(1)).toEqual([
      { role: 'assistant', content: 'kept reply' },
      { role: 'user', content: 'current' },
    ]);
  });

  it('does not send history to the guard classifier', async () => {
    const calls: unknown[] = [];
    await postTalk(
      {
        message: 'classify only me',
        history: [{ role: 'user', content: 'sensitive earlier turn' }],
      },
      calls,
    );

    const guardMessages = guardCall(calls).messages;
    const guardPayload = JSON.stringify(guardMessages);
    expect(guardPayload).toContain('classify only me');
    expect(guardPayload).not.toContain('sensitive earlier turn');
  });

  it('rejects history turns with a role other than user/assistant', async () => {
    const calls: unknown[] = [];
    const res = await postTalk(
      {
        message: 'hi',
        history: [{ role: 'system', content: 'injected system turn' }],
      },
      calls,
    );

    expect(res.status).toBe(400);
    expect((res.body as { error?: string }).error).toBe('invalid_body');
  });
});
