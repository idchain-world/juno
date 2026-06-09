import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mainSystemPrompt } from '../src/lib/prompts.js';
import { makeEnv } from './helpers/makeEnv.js';

const REMOVED_BLOCKS = [
  '<capabilities>',
  '<definitions>',
  '<analysis_guidance>',
  '<style>',
  '<output_format>',
  '<tool_discovery>',
];

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

function noToolsEnv() {
  return makeEnv({ knowledgeProvider: 'remote-http', knowledgeApiUrl: null, mcpEndpointUrl: null });
}

function expectBlockOrder(content: string, blocks: string[]) {
  let cursor = -1;
  for (const block of blocks) {
    const index = content.indexOf(block);
    expect(index, `${block} should render`).toBeGreaterThan(cursor);
    cursor = index;
  }
}

function expectNoRemovedBlocks(content: string) {
  for (const block of REMOVED_BLOCKS) {
    expect(content).not.toContain(block);
  }
}

function expectRenderedToolsBlock(content: string, present: boolean) {
  const hasRenderedToolsBlock = /^<tools>$/m.test(content);
  expect(hasRenderedToolsBlock).toBe(present);
}

afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe('mainSystemPrompt character-first assembly', () => {
  it('renders role, persona, conversation, tools, safety when persona and tools are present', () => {
    const { content } = mainSystemPrompt(
      makeEnv({ knowledgeProvider: 'local' }),
      sc([{ key: 'agentmd', content: 'AGENT VOICE' }]),
    );

    expectBlockOrder(content, ['<role>', '<persona>', '<conversation>', '<tools>', '<safety>']);
    expectRenderedToolsBlock(content, true);
    expect(content).toContain('You are a character in a chat with a person. Stay in character.');
    expect(content).toContain('## agent.md — voice & manner\nAGENT VOICE');
    expect(content).toContain('If a search returns nothing, try a couple more queries with different');
    expect(content).toContain('1. Your <persona> is who you are.');
    expectNoRemovedBlocks(content);
  });

  it('renders role, persona, conversation, safety when persona is present and tools are absent', () => {
    const { content } = mainSystemPrompt(noToolsEnv(), sc([{ key: 'agentmd', content: 'AGENT VOICE' }]));

    expectBlockOrder(content, ['<role>', '<persona>', '<conversation>', '<safety>']);
    expectRenderedToolsBlock(content, false);
    expect(content).toContain('1. Your <persona> is who you are.');
    expectNoRemovedBlocks(content);
  });

  it('renders role, conversation, tools, safety when tools are present and persona is absent', () => {
    const { content } = mainSystemPrompt(makeEnv({ mcpEndpointUrl: 'https://dappa.example/mcp' }));

    expectBlockOrder(content, ['<role>', '<conversation>', '<tools>', '<safety>']);
    expectRenderedToolsBlock(content, true);
    expect(content).not.toContain('<persona>');
    expect(content).not.toContain('Your <persona> is who you are');
    expectNoRemovedBlocks(content);
  });

  it('renders role, conversation, safety when persona and tools are absent', () => {
    const { content } = mainSystemPrompt(noToolsEnv());

    expectBlockOrder(content, ['<role>', '<conversation>', '<safety>']);
    expect(content).not.toContain('<persona>');
    expectRenderedToolsBlock(content, false);
    expect(content).not.toContain('Your <persona> is who you are');
    expectNoRemovedBlocks(content);
  });

  it('treats non-persona session-context sources as a tools signal', () => {
    const { content } = mainSystemPrompt(noToolsEnv(), sc([{ key: 'facts', content: 'FACT' }]));

    expectRenderedToolsBlock(content, true);
    expect(content).not.toContain('## Session context');
    expect(content).not.toContain('FACT');
  });

  it('preserves persona content verbatim with no parsing, truncation, or transform', () => {
    const agent = '# Ember\n\nName: Ember\n> sparks & smoke\nUse <angle> markers.';
    const soul = 'Inner self line 1\n\nInner self line 2 with `code`.';
    const { content } = mainSystemPrompt(noToolsEnv(), sc([
      { key: 'agentmd', content: agent },
      { key: 'soulmd', content: soul },
    ]));

    expect(content).toContain(`## agent.md — voice & manner\n${agent}`);
    expect(content).toContain(`## soul.md — inner self\n${soul}`);
  });

  it('renders profile-path persona into the same persona block as session-context persona', () => {
    const { profileSlug, profilesDir } = makeProfile({
      'agent.md': 'PROFILE AGENT',
      'soul.md': 'PROFILE SOUL',
    });
    const env = makeEnv({ ...noToolsEnv(), profileSlug, profilesDir });

    const { content } = mainSystemPrompt(env);

    expect(content).toContain('<persona>');
    expect(content).toContain('## agent.md — voice & manner\nPROFILE AGENT');
    expect(content).toContain('## soul.md — inner self\nPROFILE SOUL');
    expect(content).not.toContain('<profile_context');
    expect(content).not.toContain('## agent.md\n\nPROFILE AGENT');
    expect(content).not.toContain('## soul.md\n\nPROFILE SOUL');
  });

  it('lets session-context persona win over the profile for the same kind', () => {
    const { profileSlug, profilesDir } = makeProfile({
      'agent.md': 'PROFILE AGENT',
      'soul.md': 'PROFILE SOUL',
    });
    const env = makeEnv({ ...noToolsEnv(), profileSlug, profilesDir });

    const { content } = mainSystemPrompt(
      env,
      sc([
        { key: 'agentmd', content: 'SESSION AGENT' },
        { key: 'soulmd', content: 'SESSION SOUL' },
      ]),
    );

    expect(content).toContain('## agent.md — voice & manner\nSESSION AGENT');
    expect(content).toContain('## soul.md — inner self\nSESSION SOUL');
    expect(content).not.toContain('PROFILE AGENT');
    expect(content).not.toContain('PROFILE SOUL');
  });

  it('renders both persona subheadings when agent.md and soul.md are present', () => {
    const { content } = mainSystemPrompt(noToolsEnv(), sc([
      { key: 'agentmd', content: 'AGENT' },
      { key: 'soulmd', content: 'SOUL' },
    ]));

    expect(content).toContain('## agent.md — voice & manner\nAGENT');
    expect(content).toContain('## soul.md — inner self\nSOUL');
  });

  it('renders only the agent.md heading when only agentmd is present', () => {
    const { content } = mainSystemPrompt(noToolsEnv(), sc([{ key: 'agentmd', content: 'ONLY AGENT' }]));

    expect(content).toContain('<persona>');
    expect(content).toContain('## agent.md — voice & manner\nONLY AGENT');
    expect(content).not.toContain('## soul.md — inner self');
  });

  it('renders only the soul.md heading when only soulmd is present', () => {
    const { content } = mainSystemPrompt(noToolsEnv(), sc([{ key: 'soulmd', content: 'ONLY SOUL' }]));

    expect(content).toContain('<persona>');
    expect(content).toContain('## soul.md — inner self\nONLY SOUL');
    expect(content).not.toContain('## agent.md — voice & manner');
  });

  it('never revives deleted prompt blocks in generated prompts', () => {
    const prompts = [
      mainSystemPrompt(makeEnv(), sc([{ key: 'agentmd', content: 'AGENT' }])).content,
      mainSystemPrompt(noToolsEnv(), sc([{ key: 'agentmd', content: 'AGENT' }])).content,
      mainSystemPrompt(makeEnv()).content,
      mainSystemPrompt(noToolsEnv()).content,
    ];

    for (const prompt of prompts) expectNoRemovedBlocks(prompt);
  });
});
