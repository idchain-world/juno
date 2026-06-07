import { z } from 'zod';
import type { Env } from '../env.js';
import { mcpContextHeaders } from './knowledge.js';

const sessionContextSchema = z.object({
  sources: z
    .array(
      z.object({
        key: z.string().min(1),
        content: z.string(),
      }).strict(),
    )
    .default([]),
}).strict();

export type SessionContext = z.infer<typeof sessionContextSchema>;

export interface ProjectContext {
  context: Record<string, unknown>;
  tokenId: string | null;
}

let loggedMissingEndpoint = false;

export async function fetchSessionContext(
  env: Env,
  project: ProjectContext,
): Promise<SessionContext | null> {
  const endpoint = sessionContextEndpoint(env);
  if (!endpoint) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.mcpTimeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${env.mcpServiceToken}`,
        ...mcpContextHeaders(project.context),
      },
      body: JSON.stringify({ context: project.context, tokenId: project.tokenId }),
      signal: controller.signal,
    });

    if (response.status === 404) {
      if (!loggedMissingEndpoint) {
        console.info('[public-agent] session-context endpoint returned 404; continuing without session context');
        loggedMissingEndpoint = true;
      }
      return null;
    }

    const data = await response.json().catch(() => null);
    if (!response.ok) {
      console.warn(`[public-agent] session-context fetch failed status=${response.status}`);
      return null;
    }

    const parsed = sessionContextSchema.safeParse(data);
    if (!parsed.success) {
      console.warn('[public-agent] session-context response malformed; continuing without session context');
      return null;
    }
    return parsed.data;
  } catch (err) {
    const reason = (err as Error).name === 'AbortError'
      ? `timeout after ${env.mcpTimeoutMs}ms`
      : (err as Error).message;
    console.warn(`[public-agent] session-context fetch failed: ${reason}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function sessionContextEndpoint(env: Env): string | null {
  if (!env.mcpServiceToken) return null;

  const raw = env.mcpEndpointUrl ?? env.knowledgeApiUrl;
  if (!raw) return null;

  try {
    const url = new URL(raw);
    url.pathname = '/api/internal/juno/session-context';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    console.warn('[public-agent] session-context endpoint could not be derived from Juno configuration');
    return null;
  }
}
