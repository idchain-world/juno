import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Env } from '../env.js';
import { profileDevRoutes, type ProfileReloadHub } from './profile-dev.js';

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
    dataDir: '/tmp/juno-profile-dev-test-data',
    trustedProxy: true,
    maxReplyTokens: 1024,
    maxSessions: 10,
    sessionIdleMinutes: 30,
    maxTurnsPerSession: 10,
    guardModel: 'google/gemini-2.5-flash',
    maxGuardTokens: 256,
    maxMessageChars: 4000,
    knowledgeDir: '/tmp/juno-profile-dev-test-knowledge',
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
    profileSlug: 'ember',
    profilesDir: '/tmp/juno-profile-dev-test-profiles',
    judgeModel: 'anthropic/claude-3-haiku',
    identityPath: '/tmp/identity.json',
    bootTimeMs: Date.now(),
    ...overrides,
  };
}

const hub: ProfileReloadHub = {
  version: () => 1,
  subscribe: () => () => undefined,
};

function makeProfiles(metadata = true): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'juno-profile-dev-'));
  roots.push(root);
  const dir = path.join(root, 'ember');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agent.md'), '# Ember\n\nA Common, Fire-type CC0mon.\n');
  if (metadata) {
    fs.writeFileSync(
      path.join(dir, 'metadata.json'),
      JSON.stringify({
        name: 'Slowlava #199',
        chainId: 1,
        tokenContract: '0xeeb036dbbd3039429c430657ed9836568da79d5f',
        tokenId: '9274',
        image: 'https://api.cc0mon.com/cc0mon/9274/image.png',
        openseaUrl: 'https://opensea.io/assets/ethereum/0xeeb036dbbd3039429c430657ed9836568da79d5f/9274',
      }),
    );
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('profile dev chat page', () => {
  it('renders an NFT card when profile metadata exists', async () => {
    const profilesDir = makeProfiles();
    const app = profileDevRoutes(env({ profilesDir }), hub);

    const response = await app.request('/profiles/chat');
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('class="profile-card"');
    expect(html).toContain('Slowlava #199');
    expect(html).toContain('Common · Fire-type');
    expect(html).toContain('0xeeb0…9d5f #9274 (on Ethereum)');
    expect(html).toContain('https://api.cc0mon.com/cc0mon/9274/image.png');
    expect(html).toContain('https://etherscan.io/nft/0xeeb036dbbd3039429c430657ed9836568da79d5f/9274');
  });

  it('falls back to the slug header when profile metadata is absent', async () => {
    const profilesDir = makeProfiles(false);
    const app = profileDevRoutes(env({ profilesDir }), hub);

    const response = await app.request('/profiles/chat');
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('<h1>ember</h1>');
    expect(html).not.toContain('class="profile-card"');
  });
});
