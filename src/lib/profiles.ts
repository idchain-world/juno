import fs from 'node:fs';
import path from 'node:path';
import type { Env } from '../env.js';

export interface ProfileSource {
  key: string;
  content: string;
}

export interface ActiveProfile {
  slug: string;
  dir: string;
  agentMd: string | null;
  soulMd: string | null;
  systemPromptMd: string | null;
  sources: ProfileSource[];
}

const WATCHED_PROFILE_FILES = new Set(['agent.md', 'soul.md', 'system-prompt.md', 'sources.json']);

export function profileDir(env: Env, slug: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$|^[a-z0-9]$/i.test(slug)) {
    throw new Error(`invalid profile slug: ${slug}`);
  }
  return path.join(env.profilesDir, slug);
}

export function watchedProfileFile(name: string): boolean {
  return WATCHED_PROFILE_FILES.has(name.toLowerCase());
}

export function loadActiveProfile(env: Env): ActiveProfile | null {
  const slug = env.profileSlug;
  if (!slug) return null;
  const dir = profileDir(env, slug);
  if (!fs.existsSync(dir)) {
    throw new Error(`profile "${slug}" does not exist at ${dir}`);
  }
  return {
    slug,
    dir,
    agentMd: readProfileText(dir, 'agent.md'),
    soulMd: readProfileText(dir, 'soul.md'),
    systemPromptMd: readProfileText(dir, 'system-prompt.md'),
    sources: readProfileSources(dir),
  };
}

function readProfileText(dir: string, name: string): string | null {
  const file = findCaseInsensitive(dir, name);
  if (!file) return null;
  const value = fs.readFileSync(file, 'utf8').trim();
  return value.length > 0 ? value : null;
}

function findCaseInsensitive(dir: string, name: string): string | null {
  const exact = path.join(dir, name);
  if (fs.existsSync(exact)) return exact;
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const found = entries.find((entry) => entry.toLowerCase() === name.toLowerCase());
  return found ? path.join(dir, found) : null;
}

function readProfileSources(dir: string): ProfileSource[] {
  const file = findCaseInsensitive(dir, 'sources.json');
  if (!file) return [];
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  const rawSources = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { sources?: unknown }).sources)
      ? (parsed as { sources: unknown[] }).sources
      : [];
  const sources: ProfileSource[] = [];
  for (const [index, raw] of rawSources.entries()) {
    if (typeof raw === 'string') {
      const sourcePath = resolveProfilePath(dir, raw);
      sources.push({ key: raw, content: fs.readFileSync(sourcePath, 'utf8').trim() });
      continue;
    }
    if (!raw || typeof raw !== 'object') continue;
    const record = raw as { key?: unknown; path?: unknown; content?: unknown };
    const key = typeof record.key === 'string' && record.key.trim() ? record.key.trim() : `source-${index + 1}`;
    if (typeof record.content === 'string' && record.content.trim()) {
      sources.push({ key, content: record.content.trim() });
      continue;
    }
    if (typeof record.path === 'string' && record.path.trim()) {
      const sourcePath = resolveProfilePath(dir, record.path.trim());
      sources.push({ key, content: fs.readFileSync(sourcePath, 'utf8').trim() });
    }
  }
  return sources.filter((source) => source.content.length > 0);
}

function resolveProfilePath(dir: string, relativePath: string): string {
  const resolved = path.resolve(dir, relativePath);
  const root = path.resolve(dir);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`profile source escapes profile directory: ${relativePath}`);
  }
  return resolved;
}
