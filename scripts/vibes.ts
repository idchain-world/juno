import fs from 'node:fs';
import path from 'node:path';
import { mainSystemPrompt } from '../src/lib/prompts.js';
import type { ChatMessage } from '../src/lib/openrouter.js';
import { loadDotEnv, profilesDir, scriptEnv, timestamp } from './profile-env.js';

interface TestPrompt {
  id: string;
  prompt: string;
}

interface ModelReply {
  reply: string;
  model: string;
}

interface JudgeScore {
  stays_in_voice: number;
  stays_in_character: number;
  absence_of_assistant_isms: number;
  follows_own_rules: number;
  comment: string;
  more_in_character?: 'a' | 'b' | 'tie';
}

loadDotEnv();

const args = process.argv.slice(2).filter((arg) => arg !== '--ab');
if (args.length < 1 || args.length > 2) {
  console.error('Usage: pnpm vibes <slug> [slug-b]');
  process.exit(1);
}
if (!process.env.OPENROUTER_API_KEY?.trim()) {
  console.error('OPENROUTER_API_KEY is required. Put it in .env or export it before running vibes.');
  process.exit(1);
}

const [slugA, slugB] = args as [string, string?];
const root = profilesDir();
const report = slugB ? await runAb(root, slugA, slugB) : await runSolo(root, slugA);
console.log(report);

async function runSolo(rootDir: string, slug: string): Promise<string> {
  const env = scriptEnv(slug);
  const tests = loadTests(rootDir, slug);
  const rows: Array<{ test: TestPrompt; response: ModelReply; score: JudgeScore }> = [];
  for (const test of tests) {
    console.log(`[vibes] ${slug}: ${test.id}`);
    const response = await getProfileReply(env, test.prompt);
    const score = await judgeOne(env, slug, test.prompt, response.reply);
    rows.push({ test, response, score });
  }

  const aggregate = average(rows.map((row) => average(scoreValues(row.score))));
  const out = [
    `# Vibes report: ${slug}`,
    '',
    `Generated: ${new Date().toISOString()}`,
    `Profile model: ${env.openRouterModel}`,
    `Temperature: omitted (same as /talk; provider default)`,
    `Judge model: ${env.judgeModel}`,
    `Aggregate score: ${aggregate.toFixed(2)} / 5`,
    '',
    '| Prompt | Response | Voice | Character | No assistant-isms | Own rules | Comment |',
    '| --- | --- | ---: | ---: | ---: | ---: | --- |',
    ...rows.map((row) =>
      `| ${md(row.test.prompt)} | ${md(row.response.reply)} | ${row.score.stays_in_voice} | ${row.score.stays_in_character} | ${row.score.absence_of_assistant_isms} | ${row.score.follows_own_rules} | ${md(row.score.comment)} |`,
    ),
    '',
  ].join('\n');
  const file = writeReport(rootDir, slug, out);
  seedBaseline(rootDir, slug);
  return `Report: ${file}`;
}

async function runAb(rootDir: string, slugA: string, slugB: string): Promise<string> {
  const envA = scriptEnv(slugA);
  const envB = scriptEnv(slugB);
  const tests = loadTests(rootDir, slugA);
  const rows: Array<{ test: TestPrompt; a: ModelReply; b: ModelReply; scoreA: JudgeScore; scoreB: JudgeScore; compare: JudgeScore }> = [];
  for (const test of tests) {
    console.log(`[vibes] ${slugA} vs ${slugB}: ${test.id}`);
    const a = await getProfileReply(envA, test.prompt);
    const b = await getProfileReply(envB, test.prompt);
    const scoreA = await judgeOne(envA, slugA, test.prompt, a.reply);
    const scoreB = await judgeOne(envB, slugB, test.prompt, b.reply);
    const compare = await judgePair(envA, slugA, slugB, test.prompt, a.reply, b.reply);
    rows.push({ test, a, b, scoreA, scoreB, compare });
  }

  const aggA = average(rows.map((row) => average(scoreValues(row.scoreA))));
  const aggB = average(rows.map((row) => average(scoreValues(row.scoreB))));
  const out = [
    `# Vibes A/B report: ${slugA} vs ${slugB}`,
    '',
    `Generated: ${new Date().toISOString()}`,
    `Profile model: ${envA.openRouterModel}`,
    `Temperature: omitted (same as /talk; provider default)`,
    `Judge model: ${envA.judgeModel}`,
    `${slugA} aggregate: ${aggA.toFixed(2)} / 5`,
    `${slugB} aggregate: ${aggB.toFixed(2)} / 5`,
    '',
    '| Prompt | A response | B response | A avg | B avg | More in-character | Comment |',
    '| --- | --- | --- | ---: | ---: | --- | --- |',
    ...rows.map((row) =>
      `| ${md(row.test.prompt)} | ${md(row.a.reply)} | ${md(row.b.reply)} | ${average(scoreValues(row.scoreA)).toFixed(2)} | ${average(scoreValues(row.scoreB)).toFixed(2)} | ${row.compare.more_in_character ?? 'tie'} | ${md(row.compare.comment)} |`,
    ),
    '',
  ].join('\n');
  const file = writeReport(rootDir, slugA, out);
  return `Report: ${file}`;
}

function loadTests(rootDir: string, slug: string): TestPrompt[] {
  const own = path.join(rootDir, slug, 'tests.json');
  const fallback = path.join(rootDir, '_default-tests.json');
  const file = fs.existsSync(own) ? own : fallback;
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  const tests = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { prompts?: unknown }).prompts)
      ? (parsed as { prompts: unknown[] }).prompts
      : [];
  return tests.map((raw, index) => {
    if (typeof raw === 'string') return { id: `prompt-${index + 1}`, prompt: raw };
    const record = raw as { id?: unknown; prompt?: unknown };
    return {
      id: typeof record.id === 'string' ? record.id : `prompt-${index + 1}`,
      prompt: typeof record.prompt === 'string' ? record.prompt : '',
    };
  }).filter((test) => test.prompt.trim().length > 0);
}

async function getProfileReply(env: ReturnType<typeof scriptEnv>, prompt: string): Promise<ModelReply> {
  const messages: ChatMessage[] = [mainSystemPrompt(env), { role: 'user', content: prompt }];
  const data = await openRouter(env.openRouterApiKey, {
    model: env.openRouterModel,
    messages,
    max_tokens: env.maxReplyTokens,
  });
  const reply = data.choices?.[0]?.message?.content ?? '';
  return { reply, model: data.model ?? env.openRouterModel };
}

async function judgeOne(env: ReturnType<typeof scriptEnv>, slug: string, prompt: string, response: string): Promise<JudgeScore> {
  const data = await openRouter(env.openRouterApiKey, {
    model: env.judgeModel,
    messages: [
      { role: 'system', content: judgeSystemPrompt(false) },
      { role: 'user', content: JSON.stringify({ slug, profile_prompt: mainSystemPrompt(env).content, prompt, response }) },
    ],
    response_format: { type: 'json_object' },
    max_tokens: 500,
    temperature: 0,
  });
  return parseJudge(data.choices?.[0]?.message?.content ?? '{}');
}

async function judgePair(
  env: ReturnType<typeof scriptEnv>,
  slugA: string,
  slugB: string,
  prompt: string,
  responseA: string,
  responseB: string,
): Promise<JudgeScore> {
  const data = await openRouter(env.openRouterApiKey, {
    model: env.judgeModel,
    messages: [
      { role: 'system', content: judgeSystemPrompt(true) },
      { role: 'user', content: JSON.stringify({ slug_a: slugA, slug_b: slugB, prompt, response_a: responseA, response_b: responseB }) },
    ],
    response_format: { type: 'json_object' },
    max_tokens: 500,
    temperature: 0,
  });
  return parseJudge(data.choices?.[0]?.message?.content ?? '{}');
}

function judgeSystemPrompt(pair: boolean): string {
  return `You are a strict evaluator for character-chat vibes. Return one JSON object only.
Scores are integers from 1 to 5:
- stays_in_voice: distinctive voice, diction, pacing, and mood match the profile.
- stays_in_character: does not say it is an AI, model, bot, helper, or assistant unless the profile explicitly says so.
- absence_of_assistant_isms: no "Sure!", "I'd be happy to", "Let me help", generic service phrasing, or corporate support tone.
- follows_own_rules: if the profile has a Rules section, the response respects those rules.
- comment: one short explanation.
${pair ? '- more_in_character: "a", "b", or "tie" for which response is more in-character for the prompt.' : ''}
Use the full 1-5 scale. Be blunt and evidence-based.`;
}

async function openRouter(apiKey: string, body: Record<string, unknown>): Promise<any> {
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://github.com/idchain-world/juno',
      'X-Title': 'juno-vibes',
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`OpenRouter ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  return response.json();
}

function parseJudge(raw: string): JudgeScore {
  let parsed: Partial<JudgeScore>;
  try {
    parsed = JSON.parse(raw) as Partial<JudgeScore>;
  } catch {
    parsed = { comment: raw.slice(0, 200) };
  }
  return {
    stays_in_voice: clampScore(parsed.stays_in_voice),
    stays_in_character: clampScore(parsed.stays_in_character),
    absence_of_assistant_isms: clampScore(parsed.absence_of_assistant_isms),
    follows_own_rules: clampScore(parsed.follows_own_rules),
    comment: typeof parsed.comment === 'string' ? parsed.comment : '',
    more_in_character:
      parsed.more_in_character === 'a' || parsed.more_in_character === 'b' || parsed.more_in_character === 'tie'
        ? parsed.more_in_character
        : undefined,
  };
}

function clampScore(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(5, Math.round(n)));
}

function scoreValues(score: JudgeScore): number[] {
  return [score.stays_in_voice, score.stays_in_character, score.absence_of_assistant_isms, score.follows_own_rules];
}

function average(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function writeReport(rootDir: string, slug: string, content: string): string {
  const journalDir = path.join(rootDir, slug, 'journal');
  fs.mkdirSync(journalDir, { recursive: true });
  const file = path.join(journalDir, `${timestamp()}.md`);
  fs.writeFileSync(file, content);
  return file;
}

function seedBaseline(rootDir: string, slug: string): void {
  if (slug.endsWith('-baseline')) return;
  const source = path.join(rootDir, slug);
  const target = path.join(rootDir, `${slug}-baseline`);
  if (fs.existsSync(target)) return;
  fs.cpSync(source, target, {
    recursive: true,
    filter: (src) => !src.split(path.sep).includes('journal'),
  });
  console.log(`[vibes] seeded baseline profile: ${target}`);
}

function md(value: string): string {
  return value.replace(/\r?\n/g, '<br>').replace(/\|/g, '\\|');
}
