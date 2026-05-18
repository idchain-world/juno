import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSessionStore } from '../src/lib/sessions.js';
import { loadManifest } from '../src/lib/knowledge.js';
import { talkRoutes } from '../src/routes/talk.js';
import { makeEnv } from './helpers/makeEnv.js';
import { req } from './helpers/httpClient.js';

function makeTalkHarness() {
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
  });
  const app = talkRoutes(env, loadManifest(knowledgeDir), createSessionStore(env));
  return { app, root };
}

function mockOpenRouter(calls: unknown[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
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
                    reasoning: 'benign',
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
    expect(messages[0]?.content).toContain('You are test-agent');
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
});
