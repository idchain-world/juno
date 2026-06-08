import path from 'node:path';
import { DEFAULT_MODEL, DEFAULT_JUDGE_MODEL, loadDotEnv, profilesDir } from './profile-env.js';

loadDotEnv();

const slug = process.argv[2]?.trim();
if (!slug) {
  console.error('Usage: pnpm dev:profiles <slug>');
  process.exit(1);
}

process.env.JUNO_PROFILE_SLUG = slug;
process.env.JUNO_PROFILES_DIR ||= profilesDir();
process.env.PUBLIC_AGENT_NAME ||= slug;
process.env.OPENROUTER_MODEL ||= DEFAULT_MODEL;
process.env.JUNO_VIBES_JUDGE_MODEL ||= DEFAULT_JUDGE_MODEL;
process.env.PUBLIC_AGENT_HOST ||= '127.0.0.1';
process.env.OPERATOR_HOST ||= '127.0.0.1';
process.env.PUBLIC_AGENT_PORT ||= '4200';
process.env.OPERATOR_PORT ||= '4201';
process.env.PUBLIC_URL ||= `http://localhost:${process.env.PUBLIC_AGENT_PORT}`;
process.env.PUBLIC_AGENT_DATA_DIR ||= path.join(process.cwd(), 'data', 'profile-dev', slug);
process.env.PUBLIC_AGENT_KNOWLEDGE_DIR ||= path.join(process.cwd(), 'knowledge');
process.env.TALK_RATE_LIMIT_PER_MIN ||= '0';
process.env.MAX_TOKENS_PER_DAY ||= '0';

if (!process.env.OPENROUTER_API_KEY?.trim()) {
  console.error('OPENROUTER_API_KEY is required. Put it in .env or export it before running dev:profiles.');
  process.exit(1);
}

console.log(`[profiles] ${slug}`);
console.log(`[profiles] chat http://localhost:${process.env.PUBLIC_AGENT_PORT}/profiles/chat`);
console.log(`[profiles] model ${process.env.OPENROUTER_MODEL}`);
console.log(`[profiles] judge ${process.env.JUNO_VIBES_JUDGE_MODEL}`);

await import('../src/server.js');
