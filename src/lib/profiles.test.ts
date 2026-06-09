import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mainSystemPrompt } from './prompts.js';
import type { Env } from '../env.js';

const roots: string[] = [];

function env(overrides: Partial<Env> = {}): Env {
  return {
    openRouterApiKey: 'test-key',
    openRouterModel: 'google/gemini-2.5-flash',
    port: 4200,
    operatorPort: 4201,
    publicHost: '127.0.0.1',
    operatorHost: '127.0.0.1',
    publicUrl: 'http://localhost:4200',
    version: '0-test',
    agentName: 'test-agent',
    authKey: null,
    allowPublicUnauthenticated: false,
    protectTalk: false,
    maxTokensPerDay: 0,
    talkRateLimitPerMin: 0,
    dataDir: '/tmp/juno-profile-test-data',
    trustedProxy: true,
    maxReplyTokens: 1024,
    maxSessions: 10,
    sessionIdleMinutes: 30,
    maxTurnsPerSession: 10,
    guardModel: 'google/gemini-2.5-flash',
    maxGuardTokens: 256,
    maxMessageChars: 4000,
    knowledgeDir: '/tmp/juno-profile-test-knowledge',
    knowledgeProvider: 'local',
    knowledgeApiUrl: null,
    knowledgeApiAuthMode: 'none',
    knowledgeApiAuthToken: null,
    knowledgeApiTimeoutMs: 2000,
    knowledgeRemoteFallbackLocal: false,
    mcpEndpointUrl: null,
    mcpAllowedOrigin: null,
    mcpServiceToken: null,
    mcpTimeoutMs: 3000,
    requestContext: {},
    upstreamDeadlineMs: 45000,
    maxRetryAfterMs: 10000,
    requestDeadlineMs: 60000,
    maintenance: false,
    profileSlug: null,
    profilesDir: '/tmp/juno-profile-test-profiles',
    judgeModel: 'anthropic/claude-3-haiku',
    identityPath: '/tmp/identity.json',
    bootTimeMs: Date.now(),
    ...overrides,
  };
}

function makeProfile() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'juno-profiles-'));
  roots.push(root);
  const dir = path.join(root, 'ember');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agent.md'), '# Ember\n\nYou are Ember, not an assistant.');
  fs.writeFileSync(path.join(dir, 'soul.md'), '# Soul\n\nSmoke and sparks.');
  fs.writeFileSync(path.join(dir, 'system-prompt.md'), 'Speak in clipped sparks.');
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('profile prompt composition', () => {
  it('uses profile content for identity and style without removing runtime rules', () => {
    const profilesDir = makeProfile();
    const prompt = mainSystemPrompt(env({ profileSlug: 'ember', profilesDir })).content;

    expect(prompt).toContain('<role>');
    expect(prompt).toContain('<persona>');
    expect(prompt).toContain('<conversation>');
    expect(prompt).toContain('<tools>');
    expect(prompt).toContain('<safety>');
    expect(prompt).not.toContain('Speak in clipped sparks.');
    expect(prompt).toContain('You are Ember, not an assistant.');
    expect(prompt).toContain('Smoke and sparks.');
    expect(prompt).toContain('Your <persona> is who you are.');
    expect(prompt).toContain('If a search returns nothing, try a couple more queries');
    expect(prompt).not.toContain('<style>');
    expect(prompt).not.toContain('<profile_context');
    expect(prompt).not.toContain('lightweight public-facing assistant');
  });

  it('uses neutral fallback style when no profile is active', () => {
    const prompt = mainSystemPrompt(env({ knowledgeProvider: 'remote-http', knowledgeApiUrl: null })).content;

    expect(prompt).toContain('<role>');
    expect(prompt).toContain('<conversation>');
    expect(prompt).toContain('<safety>');
    expect(prompt).not.toContain('<persona>');
    expect(/^<tools>$/m.test(prompt)).toBe(false);
    expect(prompt).not.toContain('Your <persona> is who you are.');
    expect(prompt).not.toContain('Use a neutral, concise style.');
    expect(prompt).not.toContain('product-support');
    expect(prompt).not.toContain('lightweight public-facing assistant');
  });
});
