import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mainSystemPrompt } from '../src/lib/prompts.js';
import { makeEnv } from './helpers/makeEnv.js';

const PERSONA_STYLE =
  'Style is governed by the <persona> block below. Apply the voice rules described there. Do not fall back to a neutral or corporate-helpful tone.';
const FALLBACK_STYLE =
  'Use a neutral, concise style. Do not introduce an identity beyond the configured name. Answer directly without support-script filler or corporate-helpful phrasing.';

const tmpDirs: string[] = [];

function makeProfile(files: Record<string, string>): { profileSlug: string; profilesDir: string } {
  const profilesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'juno-persona-profiles-'));
  tmpDirs.push(profilesDir);
  const slug = 'testprofile';
  const dir = path.join(profilesDir, slug);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return { profileSlug: slug, profilesDir };
}

function sc(sources: Array<{ key: string; content: string }>) {
  return { sources };
}

afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe('mainSystemPrompt persona-first assembly', () => {
  it('anchors capabilities and runtime identity to the persona when persona sources are present', () => {
    const env = makeEnv({ agentName: '8dc744b8e32c672501bec9d00f6b2a7a' });
    const { content } = mainSystemPrompt(env, sc([{ key: 'agentmd', content: 'AGENT VOICE' }]));

    const capabilities = content.slice(content.indexOf('<capabilities>'), content.indexOf('</capabilities>'));
    const definitions = content.slice(content.indexOf('<definitions>'), content.indexOf('</definitions>'));
    expect(capabilities).toContain('You are the character described in the <persona> block below. You can reply');
    expect(capabilities).not.toContain(env.agentName);
    expect(definitions).toContain('- runtime: the character described in the <persona> block (you).');
    expect(definitions).not.toContain(env.agentName);
  });

  it('keeps capabilities and runtime identity on env.agentName when no persona is present', () => {
    const env = makeEnv({ agentName: 'test-worker' });
    const { content } = mainSystemPrompt(env);

    const capabilities = content.slice(content.indexOf('<capabilities>'), content.indexOf('</capabilities>'));
    const definitions = content.slice(content.indexOf('<definitions>'), content.indexOf('</definitions>'));
    expect(capabilities).toContain('You are test-worker. You can reply');
    expect(definitions).toContain('- runtime: test-worker (you).');
  });

  it('renders persona block and replaces style when session-context has agentmd + soulmd', () => {
    const { content } = mainSystemPrompt(
      makeEnv(),
      sc([
        { key: 'agentmd', content: 'AGENT VOICE' },
        { key: 'soulmd', content: 'SOUL SELF' },
      ]),
    );

    expect(content).toContain('<persona>');
    expect(content).toContain('## agent.md — your voice\nAGENT VOICE');
    expect(content).toContain('## soul.md — your inner self\nSOUL SELF');
    expect(content).toContain(`<style>\n${PERSONA_STYLE}\n</style>`);
    expect(content).not.toContain(FALLBACK_STYLE);
    const personaBlockIndex = content.indexOf('<persona>\n');
    expect(content.indexOf('</safety>')).toBeLessThan(personaBlockIndex);
    expect(personaBlockIndex).toBeLessThan(content.indexOf('<output_format>'));
  });

  it('renders only the agent.md heading when only agentmd is present', () => {
    const { content } = mainSystemPrompt(makeEnv(), sc([{ key: 'agentmd', content: 'ONLY AGENT' }]));

    expect(content).toContain('<persona>');
    expect(content).toContain('## agent.md — your voice\nONLY AGENT');
    expect(content).not.toContain('## soul.md — your inner self');
  });

  it('renders only the soul.md heading when only soulmd is present', () => {
    const { content } = mainSystemPrompt(makeEnv(), sc([{ key: 'soulmd', content: 'ONLY SOUL' }]));

    expect(content).toContain('<persona>');
    expect(content).toContain('## soul.md — your inner self\nONLY SOUL');
    expect(content).not.toContain('## agent.md — your voice');
  });

  it('keeps today fallback prompt verbatim with no persona sources and no profile (regression guard)', () => {
    const env = makeEnv(); // profileSlug null

    const baseline = mainSystemPrompt(env);
    expect(baseline.content).toContain(`<style>\n${FALLBACK_STYLE}\n</style>`);
    expect(baseline.content).not.toContain('<persona>');
    expect(baseline.content.indexOf('<output_format>')).toBeLessThan(baseline.content.indexOf('<safety>'));

    // A non-persona session source still renders under ## Session context, unchanged.
    const withFacts = mainSystemPrompt(env, sc([{ key: 'facts', content: 'FACT' }]));
    expect(withFacts.content).not.toContain('<persona>');
    expect(withFacts.content).toContain(`<style>\n${FALLBACK_STYLE}\n</style>`);
    expect(withFacts.content).toContain('## Session context');
    expect(withFacts.content).toContain('### facts\n\nFACT');
  });

  it('renders persona block from the profile path when no session-context is present', () => {
    const { profileSlug, profilesDir } = makeProfile({
      'agent.md': 'PROFILE AGENT',
      'soul.md': 'PROFILE SOUL',
    });
    const env = makeEnv({ profileSlug, profilesDir });

    const { content } = mainSystemPrompt(env);

    expect(content).toContain('<persona>');
    expect(content).toContain('## agent.md — your voice\nPROFILE AGENT');
    expect(content).toContain('## soul.md — your inner self\nPROFILE SOUL');
    expect(content).toContain(`<style>\n${PERSONA_STYLE}\n</style>`);
    // Persona content is not duplicated in <profile_context> (paths converged).
    expect(content).not.toContain('## agent.md\n\nPROFILE AGENT');
    expect(content).not.toContain('## soul.md\n\nPROFILE SOUL');
  });

  it('lets session-context persona win over the profile for the same kind', () => {
    const { profileSlug, profilesDir } = makeProfile({
      'agent.md': 'PROFILE AGENT',
      'soul.md': 'PROFILE SOUL',
    });
    const env = makeEnv({ profileSlug, profilesDir });

    const { content } = mainSystemPrompt(
      env,
      sc([
        { key: 'agentmd', content: 'SESSION AGENT' },
        { key: 'soulmd', content: 'SESSION SOUL' },
      ]),
    );

    expect(content).toContain('## agent.md — your voice\nSESSION AGENT');
    expect(content).toContain('## soul.md — your inner self\nSESSION SOUL');
    expect(content).not.toContain('PROFILE AGENT');
    expect(content).not.toContain('PROFILE SOUL');
  });

  it('puts persona near the top and non-persona session sources under Session context at the bottom', () => {
    const { content } = mainSystemPrompt(
      makeEnv(),
      sc([
        { key: 'agentmd', content: 'AGENT' },
        { key: 'facts', content: 'FACTUAL' },
      ]),
    );

    expect(content).toContain('<persona>');
    expect(content).toContain('## Session context');
    expect(content).toContain('### facts\n\nFACTUAL');
    // The persona source is NOT rendered under Session context.
    expect(content).not.toContain('### agentmd');
    expect(content.indexOf('<persona>')).toBeLessThan(content.indexOf('## Session context'));
  });
});
