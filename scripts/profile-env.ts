import fs from 'node:fs';
import path from 'node:path';
import type { Env } from '../src/env.js';

export const DEFAULT_MODEL = 'google/gemini-2.5-flash';
export const DEFAULT_JUDGE_MODEL = 'anthropic/claude-3-haiku';

export function loadDotEnv(file = path.resolve(process.cwd(), '.env')): void {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
    if (!match) continue;
    const key = match[1]!;
    let value = match[2]!;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] ??= value;
  }
}

export function profilesDir(): string {
  return path.resolve(process.env.JUNO_PROFILES_DIR?.trim() || path.join(process.cwd(), 'profiles'));
}

export function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export function scriptEnv(slug: string): Env {
  return {
    openRouterApiKey: process.env.OPENROUTER_API_KEY?.trim() || '',
    openRouterModel: process.env.OPENROUTER_MODEL?.trim() || DEFAULT_MODEL,
    port: Number(process.env.PUBLIC_AGENT_PORT || 4200),
    operatorPort: Number(process.env.OPERATOR_PORT || 4201),
    publicHost: process.env.PUBLIC_AGENT_HOST?.trim() || '127.0.0.1',
    operatorHost: process.env.OPERATOR_HOST?.trim() || '127.0.0.1',
    publicUrl: process.env.PUBLIC_URL?.trim() || 'http://localhost:4200',
    version: 'profile-dev',
    agentName: process.env.PUBLIC_AGENT_NAME?.trim() || slug,
    authKey: process.env.PUBLIC_AGENT_AUTH_KEY?.trim() || null,
    allowPublicUnauthenticated: process.env.ALLOW_PUBLIC_UNAUTHENTICATED === 'true',
    protectTalk: process.env.PROTECT_TALK === 'true',
    maxTokensPerDay: Number(process.env.MAX_TOKENS_PER_DAY || 0),
    talkRateLimitPerMin: Number(process.env.TALK_RATE_LIMIT_PER_MIN || 0),
    dataDir: path.resolve(process.env.PUBLIC_AGENT_DATA_DIR?.trim() || path.join(process.cwd(), 'data', 'profile-dev', slug)),
    trustedProxy: true,
    maxReplyTokens: Number(process.env.MAX_REPLY_TOKENS || 512),
    maxSessions: Number(process.env.MAX_SESSIONS || 100),
    sessionIdleMinutes: Number(process.env.SESSION_IDLE_MINUTES || 30),
    maxTurnsPerSession: Number(process.env.MAX_TURNS_PER_SESSION || 40),
    guardModel: process.env.GUARD_MODEL?.trim() || process.env.OPENROUTER_MODEL?.trim() || DEFAULT_MODEL,
    maxGuardTokens: Number(process.env.MAX_GUARD_TOKENS || 256),
    maxMessageChars: Number(process.env.MAX_MESSAGE_CHARS || 4000),
    knowledgeDir: path.resolve(process.env.PUBLIC_AGENT_KNOWLEDGE_DIR?.trim() || path.join(process.cwd(), 'knowledge')),
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
    upstreamDeadlineMs: Number(process.env.UPSTREAM_DEADLINE_MS || 45000),
    maxRetryAfterMs: Number(process.env.MAX_RETRY_AFTER_MS || 10000),
    requestDeadlineMs: Number(process.env.REQUEST_DEADLINE_MS || 60000),
    maintenance: false,
    profileSlug: slug,
    profilesDir: profilesDir(),
    judgeModel: process.env.JUNO_VIBES_JUDGE_MODEL?.trim() || DEFAULT_JUDGE_MODEL,
    identityPath: process.env.IDENTITY_PATH?.trim() || '/tmp/juno-profile-identity.json',
    bootTimeMs: Date.now(),
  };
}
