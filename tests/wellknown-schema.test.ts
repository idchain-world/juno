/**
 * Well-known schema test — must match the CLI schema validator in
 * src/cli/public-commands.ts and the remote heartbeat fallback in
 * src/lib/remote-heartbeat.ts.
 *
 * Required fields:
 *   - service_type: "public-agent"
 *   - version: non-empty string
 *   - endpoints.talk: string
 *   - public_url: valid absolute URL
 *
 * Plus the RESTAP discovery fields and legacy fields older clients expect.
 */
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { wellknownRoutes } from '../src/routes/wellknown.js';
import { makeEnv } from './helpers/makeEnv.js';
import { req } from './helpers/httpClient.js';

describe('well-known schema matches CLI/manager contract', () => {
  it('emits service_type: "public-agent"', async () => {
    const env = makeEnv();
    const app = new Hono().route('/', wellknownRoutes(env));
    const res = await req(app, 'GET', '/.well-known/restap.json');
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body.service_type).toBe('public-agent');
  });

  it('includes version, name, and public_url', async () => {
    const env = makeEnv({ version: '1.2.3', agentName: 'friendly-bot', publicUrl: 'https://bot.example.com' });
    const app = new Hono().route('/', wellknownRoutes(env));
    const res = await req(app, 'GET', '/.well-known/restap.json');
    const body = res.body as Record<string, unknown>;
    expect(body.version).toBe('1.2.3');
    expect(body.name).toBe('friendly-bot');
    expect(body.public_url).toBe('https://bot.example.com');
  });

  it('endpoints object contains talk, news, well_known, health, identity', async () => {
    const env = makeEnv();
    const app = new Hono().route('/', wellknownRoutes(env));
    const res = await req(app, 'GET', '/.well-known/restap.json');
    const body = res.body as Record<string, unknown>;
    const endpoints = body.endpoints as Record<string, unknown>;
    expect(endpoints.talk).toBe('/talk');
    expect(endpoints.news).toBe('/news');
    expect(endpoints.well_known).toBe('/.well-known/restap.json');
    expect(endpoints.health).toBe('/health');
    expect(endpoints.identity).toBe('/identity');
  });

  it('capabilities array declares RESTAP talk and news endpoints', async () => {
    const env = makeEnv();
    const app = new Hono().route('/', wellknownRoutes(env));
    const res = await req(app, 'GET', '/.well-known/restap.json');
    const body = res.body as Record<string, unknown>;
    const capabilities = body.capabilities as Array<Record<string, unknown>>;
    expect(capabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'talk',
          method: 'POST',
          endpoint: '/talk',
          output_formats: ['application/json', 'text/event-stream'],
          streaming: expect.objectContaining({
            supported: true,
            transport: 'sse',
            events: ['message.start', 'message.delta', 'message.end', 'error', 'done'],
          }),
          sessions: { supported: true },
        }),
        expect.objectContaining({
          id: 'news',
          method: 'GET',
          endpoint: '/news',
        }),
        expect.objectContaining({
          id: 'news_receive',
          method: 'POST',
          endpoint: '/news',
        }),
      ]),
    );
    expect(body.legacy_capabilities).toEqual(['talk', 'news', 'mcp', 'search_knowledge', 'read_knowledge']);
  });

  it('includes RESTAP agent, protocols, and package metadata', async () => {
    const env = makeEnv({ agentName: 'friendly-bot' });
    const app = new Hono().route('/', wellknownRoutes(env));
    const res = await req(app, 'GET', '/.well-known/restap.json');
    const body = res.body as Record<string, unknown>;
    expect(body.restap_version).toBe('0.1.1-beta');
    expect(body.agent).toMatchObject({ name: 'friendly-bot' });
    expect(body.protocols).toMatchObject({
      restap: { available: true, endpoint: '/' },
      mcp: { available: true, endpoint: '/mcp' },
    });
    expect(body.packages).toEqual([
      expect.objectContaining({ type: 'claude-skill', skill_file: '/.well-known/skill.md' }),
    ]);
  });

  it('auth object declares talk=none, operator=ssh-tunnel', async () => {
    const env = makeEnv();
    const app = new Hono().route('/', wellknownRoutes(env));
    const res = await req(app, 'GET', '/.well-known/restap.json');
    const body = res.body as Record<string, unknown>;
    const auth = body.auth as Record<string, unknown>;
    expect(auth.talk).toBe('none');
    expect(auth.operator).toBe('ssh-tunnel');
  });

  it('limits object carries max_message_chars and talk_rate_per_min from env', async () => {
    const env = makeEnv({ maxMessageChars: 4096, talkRateLimitPerMin: 42 });
    const app = new Hono().route('/', wellknownRoutes(env));
    const res = await req(app, 'GET', '/.well-known/restap.json');
    const body = res.body as Record<string, unknown>;
    const limits = body.limits as Record<string, unknown>;
    expect(limits.max_message_chars).toBe(4096);
    expect(limits.talk_rate_per_min).toBe(42);
  });

  it('passes the CLI validator (all required fields present, public_url parseable)', async () => {
    const env = makeEnv({ publicUrl: 'https://agent.example.com' });
    const app = new Hono().route('/', wellknownRoutes(env));
    const res = await req(app, 'GET', '/.well-known/restap.json');
    const body = res.body as Record<string, unknown>;
    expect(body.service_type).toBe('public-agent');
    expect(typeof body.version).toBe('string');
    expect((body.version as string).length).toBeGreaterThan(0);
    expect(typeof body.public_url).toBe('string');
    expect(() => new URL(body.public_url as string)).not.toThrow();
    const endpoints = body.endpoints as Record<string, unknown>;
    expect(typeof endpoints.talk).toBe('string');
    expect((endpoints.talk as string).length).toBeGreaterThan(0);
  });
});
