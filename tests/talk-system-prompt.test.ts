import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSessionStore } from '../src/lib/sessions.js';
import { loadManifest } from '../src/lib/knowledge.js';
import { listInbox } from '../src/lib/inbox.js';
import { mainSystemPrompt, REFUSAL_REPLY } from '../src/lib/prompts.js';
import { talkRoutes } from '../src/routes/talk.js';
import { makeEnv } from './helpers/makeEnv.js';
import { req } from './helpers/httpClient.js';

function makeTalkHarness(envOverrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'juno-talk-system-'));
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

function mockOpenRouter(
  calls: unknown[],
  sessionContextResponse?: { status: number; body?: unknown },
  sessionContextCalls: Array<{ url: string; init?: RequestInit }> = [],
  guardClassification: 'allow' | 'refuse' | 'review' = 'allow',
) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href.includes('/api/internal/juno/session-context')) {
        sessionContextCalls.push({ url: href, init });
        if (!sessionContextResponse) return new Response('not found', { status: 404 });
        return new Response(
          sessionContextResponse.body === undefined ? null : JSON.stringify(sessionContextResponse.body),
          {
            status: sessionContextResponse.status,
            headers: { 'content-type': 'application/json' },
          },
        );
      }

      const body = JSON.parse(String(init?.body ?? '{}'));
      calls.push(body);

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

describe('/talk per-request system prompt', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('applies body.system as a trusted system prompt on top of the base prompt', async () => {
    const calls: unknown[] = [];
    const res = await postTalk(
      { message: 'hello', system: 'Answer as the tenant-specific concierge.' },
      calls,
    );

    expect(res.status).toBe(200);
    const messages = mainCall(calls).messages;
    expect(messages[0]?.role).toBe('system');
    expect(messages[0]?.content).toContain('You are a character in a chat with a person. Stay in character.');
    expect(messages[1]).toEqual({
      role: 'system',
      content: 'Answer as the tenant-specific concierge.',
    });
    expect(messages[2]).toEqual({ role: 'user', content: 'hello' });
  });

  it('does not send body.system to the guard classifier', async () => {
    const calls: unknown[] = [];
    await postTalk(
      {
        message: 'What can you do?',
        system: 'This trusted system text must bypass guard classification.',
      },
      calls,
    );

    const guardMessages = guardCall(calls).messages;
    const guardPayload = JSON.stringify(guardMessages);
    expect(guardPayload).toContain('What can you do?');
    expect(guardPayload).not.toContain('This trusted system text must bypass guard classification.');
  });

  it('still sends body.message to the guard classifier', async () => {
    const calls: unknown[] = [];
    await postTalk(
      { message: 'Classify this end-user message.', system: 'Trusted per-request instructions.' },
      calls,
    );

    const guardMessages = guardCall(calls).messages;
    expect(guardMessages).toHaveLength(2);
    expect(guardMessages[0]?.role).toBe('system');
    expect(guardMessages[1]?.role).toBe('user');
    expect(guardMessages[1]?.content).toContain('Classify this end-user message.');
  });

  it('keeps absent body.system behavior unchanged', async () => {
    const calls: unknown[] = [];
    const res = await postTalk({ message: 'hello without system' }, calls);

    expect(res.status).toBe(200);
    const messages = mainCall(calls).messages;
    expect(messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(messages[1]).toEqual({ role: 'user', content: 'hello without system' });
  });

  it('short-circuits refused guard verdicts with the canned refusal and no main LLM call', async () => {
    const calls: unknown[] = [];
    const { app, env, root } = makeTalkHarness();
    mockOpenRouter(calls, undefined, [], 'refuse');

    try {
      const res = await req(app, 'POST', '/talk', {
        headers: { 'x-forwarded-for': '203.0.113.10' },
        body: { message: 'blocked request' },
      });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        reply: REFUSAL_REPLY,
        model: 'guard-test-model',
        guard: { classification: 'refuse', violation_type: 'jailbreak' },
      });
      expect(calls).toHaveLength(1);
      expect(guardCall(calls)).toBeDefined();
      expect(mainCall(calls)).toBeUndefined();
      const [entry] = listInbox(env, 'all');
      expect(entry?.reply).toBe(REFUSAL_REPLY);
      expect(entry?.guard?.classification).toBe('refuse');
      expect(entry?.priority).toBe('normal');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('lets review guard verdicts run the main LLM while preserving review audit metadata', async () => {
    const calls: unknown[] = [];
    const { app, env, root } = makeTalkHarness();
    mockOpenRouter(calls, undefined, [], 'review');

    try {
      const res = await req(app, 'POST', '/talk', {
        headers: { 'x-forwarded-for': '203.0.113.10' },
        body: { message: 'What are your traits?' },
      });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        reply: 'ok',
        model: 'main-test-model',
        guard: { classification: 'review', violation_type: 'jailbreak' },
      });
      expect(guardCall(calls)).toBeDefined();
      expect(mainCall(calls)).toBeDefined();
      const [entry] = listInbox(env, 'all');
      expect(entry?.reply).toBe('ok');
      expect(entry?.model).toBe('main-test-model');
      expect(entry?.guard?.classification).toBe('review');
      expect(entry?.priority).toBe('review');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps allowed guard verdict behavior on the main LLM path unchanged', async () => {
    const calls: unknown[] = [];
    const { app, env, root } = makeTalkHarness();
    mockOpenRouter(calls, undefined, [], 'allow');

    try {
      const res = await req(app, 'POST', '/talk', {
        headers: { 'x-forwarded-for': '203.0.113.10' },
        body: { message: 'hello' },
      });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        reply: 'ok',
        model: 'main-test-model',
        guard: { classification: 'allow', violation_type: 'none' },
      });
      expect(guardCall(calls)).toBeDefined();
      expect(mainCall(calls)).toBeDefined();
      const [entry] = listInbox(env, 'all');
      expect(entry?.reply).toBe('ok');
      expect(entry?.guard?.classification).toBe('allow');
      expect(entry?.priority).toBe('normal');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses non-persona session-context as a tools signal when fetch succeeds', async () => {
    const calls: unknown[] = [];
    const { app, root } = makeTalkHarness({
      mcpEndpointUrl: 'https://dappa.example/api/internal/juno/mcp',
      mcpServiceToken: 'service-token',
      requestContext: { projectSlug: 'normies', chainId: '8453', tokenContract: '0xabc' },
    });
    mockOpenRouter(calls, {
      status: 200,
      body: { sources: [{ key: 'persona', content: 'You know the Normies canon.' }] },
    });

    try {
      const res = await req(app, 'POST', '/talk', {
        headers: { 'x-forwarded-for': '203.0.113.10' },
        body: { message: 'hello', context: { tokenId: '7' } },
      });

      expect(res.status).toBe(200);
      const content = mainCall(calls).messages[0]?.content ?? '';
      expect(content).toContain('<tools>');
      expect(content).not.toContain('## Session context');
      expect(content).not.toContain('### persona');
      expect(content).not.toContain('You know the Normies canon.');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps the system prompt unchanged when session-context fetch returns null', async () => {
    const calls: unknown[] = [];
    const { app, env, root } = makeTalkHarness({
      mcpEndpointUrl: 'https://dappa.example/api/internal/juno/mcp',
      mcpServiceToken: 'service-token',
    });
    mockOpenRouter(calls, { status: 404 });

    try {
      const res = await req(app, 'POST', '/talk', {
        headers: { 'x-forwarded-for': '203.0.113.10' },
        body: { message: 'hello', context: { tokenId: '7' } },
      });

      expect(res.status).toBe(200);
      expect(mainCall(calls).messages[0]?.content).toBe(mainSystemPrompt(env).content);
      expect(mainCall(calls).messages[0]?.content).not.toContain('## Session context');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reuses cached session-context on the second turn of the same session', async () => {
    const calls: unknown[] = [];
    const { app, root } = makeTalkHarness({
      mcpEndpointUrl: 'https://dappa.example/api/internal/juno/mcp',
      mcpServiceToken: 'service-token',
    });
    mockOpenRouter(calls, {
      status: 200,
      body: { sources: [{ key: 'persona', content: 'Cached context.' }] },
    });

    try {
      const first = await req(app, 'POST', '/talk', {
        headers: { 'x-forwarded-for': '203.0.113.10' },
        body: { message: 'first', context: { tokenId: '7' } },
      });
      const firstBody = first.body as { session_id: string };
      const second = await req(app, 'POST', '/talk', {
        headers: { 'x-forwarded-for': '203.0.113.10' },
        body: { message: 'second', session_id: firstBody.session_id, context: { tokenId: '7' } },
      });

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
      const sessionContextCalls = fetchMock.mock.calls.filter(([url]) =>
        String(url).includes('/api/internal/juno/session-context'),
      );
      expect(sessionContextCalls).toHaveLength(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('forwards the drafts studio override header to session-context fetch', async () => {
    const calls: unknown[] = [];
    const sessionContextCalls: Array<{ url: string; init?: RequestInit }> = [];
    const { app, root } = makeTalkHarness({
      mcpEndpointUrl: 'https://dappa.example/api/internal/juno/mcp',
      mcpServiceToken: 'service-token',
    });
    mockOpenRouter(
      calls,
      { status: 200, body: { sources: [{ key: 'persona', content: 'Draft context.' }] } },
      sessionContextCalls,
    );

    try {
      const res = await req(app, 'POST', '/talk', {
        headers: {
          'x-forwarded-for': '203.0.113.10',
          'x-dappa-studio-override': 'drafts',
        },
        body: { message: 'hello', context: { tokenId: '7' } },
      });

      expect(res.status).toBe(200);
      expect(sessionContextCalls).toHaveLength(1);
      expect(sessionContextCalls[0]?.init?.headers).toMatchObject({
        'x-dappa-studio-override': 'drafts',
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not cache drafts studio session-context between turns', async () => {
    const calls: unknown[] = [];
    const sessionContextCalls: Array<{ url: string; init?: RequestInit }> = [];
    const { app, root } = makeTalkHarness({
      mcpEndpointUrl: 'https://dappa.example/api/internal/juno/mcp',
      mcpServiceToken: 'service-token',
    });
    mockOpenRouter(
      calls,
      { status: 200, body: { sources: [{ key: 'persona', content: 'Draft context.' }] } },
      sessionContextCalls,
    );

    try {
      const first = await req(app, 'POST', '/talk', {
        headers: {
          'x-forwarded-for': '203.0.113.10',
          'x-dappa-studio-override': 'drafts',
        },
        body: { message: 'first', context: { tokenId: '7' } },
      });
      const firstBody = first.body as { session_id: string };
      const second = await req(app, 'POST', '/talk', {
        headers: {
          'x-forwarded-for': '203.0.113.10',
          'x-dappa-studio-override': 'drafts',
        },
        body: { message: 'second', session_id: firstBody.session_id, context: { tokenId: '7' } },
      });

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(sessionContextCalls).toHaveLength(2);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
