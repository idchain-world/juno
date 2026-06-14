import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSessionStore } from '../src/lib/sessions.js';
import { loadManifest } from '../src/lib/knowledge.js';
import { tailNews } from '../src/lib/news-log.js';
import { talkRoutes } from '../src/routes/talk.js';
import { publicNewsRoutes } from '../src/routes/public-news.js';
import { makeEnv } from './helpers/makeEnv.js';
import { req } from './helpers/httpClient.js';

// Reproduces the DAPPA/Juno news -> talk shared-session gap: a news item posted
// into a session must be visible to the agent on the next /talk turn, because
// news and talk share ONE conversation/memory. The talk and news routes here
// share a single SessionStore, exactly as the server wires them.

function makeHarness(envOverrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'juno-news-talk-'));
  const dataDir = path.join(root, 'data');
  const knowledgeDir = path.join(root, 'knowledge');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(knowledgeDir, { recursive: true });
  fs.writeFileSync(path.join(knowledgeDir, 'topic.md'), '# Topic\n\nTest content.');

  const env = makeEnv({
    dataDir,
    knowledgeDir,
    trustedProxy: true,
    guardEnabled: false,
    maxReplyTokens: 1024,
    ...envOverrides,
  });
  const sessions = createSessionStore(env);
  const talkApp = talkRoutes(env, loadManifest(knowledgeDir), sessions);
  const newsApp = publicNewsRoutes(env, sessions);
  return { talkApp, newsApp, env, sessions, root };
}

function mockOpenRouter(calls: unknown[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href.includes('/api/internal/juno/session-context')) {
        return new Response('not found', { status: 404 });
      }
      calls.push(JSON.parse(String(init?.body ?? '{}')));
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

function mainCalls(calls: unknown[]) {
  return calls.filter(
    (call) => !((call as { response_format?: unknown }).response_format),
  ) as Array<{ messages: Array<{ role: string; content: string }> }>;
}

describe('news -> talk shared session', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('threads a session news item into the next /talk turn the model sees', async () => {
    const calls: unknown[] = [];
    const { talkApp, newsApp, env, sessions, root } = makeHarness();
    mockOpenRouter(calls);

    try {
      // 1) First talk mints the session.
      const first = await req(talkApp, 'POST', '/talk', {
        headers: { 'x-forwarded-for': '203.0.113.10' },
        body: { message: 'remember my favorite color when I tell you' },
      });
      expect(first.status).toBe(200);
      const sessionId = (first.body as { session_id: string }).session_id;
      const turnsAfterFirstTalk = sessions.getOrCreate(sessionId).session.turnCount;

      // 2) News posts the fact into the SAME session (fire-and-forget).
      const news = await req(newsApp, 'POST', '/news', {
        body: { session_id: sessionId, from: 'owner', message: 'My favorite color is chartreuse' },
      });
      expect(news.status).toBe(200);
      expect((news.body as { id: number }).id).toBeGreaterThan(0);

      // News must NOT consume a /talk turn.
      expect(sessions.getOrCreate(sessionId).session.turnCount).toBe(turnsAfterFirstTalk);

      // 3) Second talk on the same session asks the question.
      const second = await req(talkApp, 'POST', '/talk', {
        headers: { 'x-forwarded-for': '203.0.113.10' },
        body: { message: "what's my favorite color?", session_id: sessionId },
      });
      expect(second.status).toBe(200);

      // The model messages for the SECOND turn must contain the news item,
      // labeled as consume-only context, ahead of the new user question.
      const secondMain = mainCalls(calls).at(-1)!;
      const newsMsg = secondMain.messages.find((m) => m.content.includes('chartreuse'));
      expect(newsMsg, 'news item should be threaded into talk context').toBeDefined();
      expect(newsMsg!.role).toBe('user');
      expect(newsMsg!.content).toBe(
        '[NEWS - informational only. Do NOT reply to this. This is context for you to consume and remember.] From: owner\nMy favorite color is chartreuse',
      );

      // Ordering: the threaded news precedes the current user question.
      const newsIdx = secondMain.messages.findIndex((m) => m.content.includes('chartreuse'));
      const questionIdx = secondMain.messages.findIndex((m) =>
        m.content.includes("what's my favorite color?"),
      );
      expect(newsIdx).toBeGreaterThanOrEqual(0);
      expect(questionIdx).toBeGreaterThan(newsIdx);

      // get_news still reads the news log (unchanged contract).
      const log = tailNews(env, 0, 100, { sessionId });
      expect(log.items).toHaveLength(1);
      expect(log.items[0]?.message).toBe('My favorite color is chartreuse');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
