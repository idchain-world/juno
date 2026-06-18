import type { Env } from '../env.js';
import { mainSystemPrompt } from './prompts.js';
import { retryFetch, HttpRetryError } from './retry.js';

export interface OpenRouterResult {
  reply: string;
  usage: { prompt: number; completion: number; total: number };
  model: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface CallOptions {
  model?: string;
  maxTokens?: number;
  responseFormat?: Record<string, unknown>;
  tools?: ToolDefinition[];
  toolChoice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
  temperature?: number;
}

export interface StreamDelta {
  text: string;
}

export interface RawAssistantMessage {
  content: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  model: string;
  usage: { prompt: number; completion: number; total: number };
  finishReason: string | null;
}

// Sentinel error for sanitized upstream failures. The status is preserved for
// callers that need to distinguish context-overflow (413) from other errors.
export class UpstreamError extends Error {
  constructor(
    readonly status: number,
    readonly sanitizedReason: string,
  ) {
    super(`openrouter_upstream_error status=${status}`);
    this.name = 'UpstreamError';
  }
}

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

function buildRequestBody(model: string, messages: ChatMessage[], opts: CallOptions): Record<string, unknown> {
  const body: Record<string, unknown> = { model, messages };
  if (opts.maxTokens && opts.maxTokens > 0) body.max_tokens = opts.maxTokens;
  if (opts.responseFormat) body.response_format = opts.responseFormat;
  if (opts.tools && opts.tools.length > 0) body.tools = opts.tools;
  if (opts.toolChoice !== undefined) body.tool_choice = opts.toolChoice;
  if (typeof opts.temperature === 'number') body.temperature = opts.temperature;
  return body;
}

function openRouterHeaders(env: Env): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${env.openRouterApiKey}`,
    'HTTP-Referer': 'https://github.com/idchain-world/juno',
    'X-Title': env.agentName,
  };
}

async function call(
  env: Env,
  messages: ChatMessage[],
  opts: CallOptions,
): Promise<RawAssistantMessage> {
  const model = opts.model ?? env.openRouterModel;
  const body = buildRequestBody(model, messages, opts);

  const resp = await retryFetch(
    () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), env.upstreamDeadlineMs);
      return fetch(ENDPOINT, {
        method: 'POST',
        headers: openRouterHeaders(env),
        body: JSON.stringify(body),
        signal: controller.signal,
      }).finally(() => clearTimeout(timer));
    },
    {
      label: `openrouter model=${model}`,
      maxRetryAfterMs: env.maxRetryAfterMs,
    },
  ).catch((err: unknown) => {
    if (err instanceof HttpRetryError) {
      // F-07: log full body server-side; do NOT include in thrown error.
      console.error(
        `[public-agent] openrouter upstream error status=${err.status} body=${err.body}`,
      );
      throw new UpstreamError(err.status, `http_${err.status}`);
    }
    throw err;
  });

  const data = (await resp.json()) as {
    choices?: Array<{
      message?: {
        content?: string | null;
        tool_calls?: Array<{
          id: string;
          type: 'function';
          function: { name: string; arguments: string };
        }>;
      };
      finish_reason?: string | null;
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    model?: string;
  };

  const choice = data.choices?.[0];
  const message = choice?.message ?? {};
  const content = typeof message.content === 'string' ? message.content : '';
  const tool_calls = Array.isArray(message.tool_calls) ? message.tool_calls : undefined;

  if (!content && (!tool_calls || tool_calls.length === 0)) {
    throw new Error('openrouter returned empty completion');
  }

  return {
    content,
    tool_calls,
    model: data.model ?? model,
    usage: {
      prompt: data.usage?.prompt_tokens ?? 0,
      completion: data.usage?.completion_tokens ?? 0,
      total: data.usage?.total_tokens ?? 0,
    },
    finishReason: choice?.finish_reason ?? null,
  };
}

function mergeToolCallChunk(
  toolCalls: NonNullable<RawAssistantMessage['tool_calls']>,
  chunk: {
    index?: number;
    id?: string;
    type?: 'function';
    function?: { name?: string; arguments?: string };
  },
) {
  const index = typeof chunk.index === 'number' ? chunk.index : toolCalls.length;
  const current =
    toolCalls[index] ??
    {
      id: '',
      type: 'function' as const,
      function: { name: '', arguments: '' },
    };

  toolCalls[index] = {
    id: chunk.id ?? current.id,
    type: chunk.type ?? current.type,
    function: {
      name: chunk.function?.name ? current.function.name + chunk.function.name : current.function.name,
      arguments:
        typeof chunk.function?.arguments === 'string'
          ? current.function.arguments + chunk.function.arguments
          : current.function.arguments,
    },
  };
}

function parseSseEvents(text: string): string[] {
  const events: string[] = [];
  const normalized = text.replace(/\r\n/g, '\n');
  for (const frame of normalized.split('\n\n')) {
    const dataLines = frame
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart());
    if (dataLines.length > 0) events.push(dataLines.join('\n'));
  }
  return events;
}

// Raw streaming call for /talk SSE. The callback fires as soon as content
// deltas arrive from OpenRouter, while the returned message preserves the
// same shape the tool loop already understands.
export async function openRouterRawStream(
  env: Env,
  messages: ChatMessage[],
  opts: CallOptions = {},
  onDelta: (delta: StreamDelta) => void,
): Promise<RawAssistantMessage> {
  const model = opts.model ?? env.openRouterModel;
  const body = {
    ...buildRequestBody(model, messages, opts),
    stream: true,
    stream_options: { include_usage: true },
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.upstreamDeadlineMs);

  const resp = await retryFetch(
    () =>
      fetch(ENDPOINT, {
        method: 'POST',
        headers: openRouterHeaders(env),
        body: JSON.stringify(body),
        signal: controller.signal,
      }),
    {
      label: `openrouter stream model=${model}`,
      maxRetryAfterMs: env.maxRetryAfterMs,
    },
  ).catch((err: unknown) => {
    clearTimeout(timer);
    if (err instanceof HttpRetryError) {
      console.error(
        `[public-agent] openrouter upstream error status=${err.status} body=${err.body}`,
      );
      throw new UpstreamError(err.status, `http_${err.status}`);
    }
    throw err;
  });

  const reader = resp.body?.getReader();
  if (!reader) {
    clearTimeout(timer);
    throw new Error('openrouter returned empty stream');
  }

  const decoder = new TextDecoder();
  const toolCalls: NonNullable<RawAssistantMessage['tool_calls']> = [];
  let content = '';
  let responseModel = model;
  let usage = { prompt: 0, completion: 0, total: 0 };
  let finishReason: string | null = null;
  let buffered = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      buffered = buffered.replace(/\r\n/g, '\n');
      const lastBoundary = buffered.lastIndexOf('\n\n');
      if (lastBoundary < 0) continue;

      const complete = buffered.slice(0, lastBoundary + 2);
      buffered = buffered.slice(lastBoundary + 2);
      for (const event of parseSseEvents(complete)) {
        if (event === '[DONE]') continue;
        const data = JSON.parse(event) as {
          model?: string;
          choices?: Array<{
            delta?: {
              content?: string | null;
              tool_calls?: Array<{
                index?: number;
                id?: string;
                type?: 'function';
                function?: { name?: string; arguments?: string };
              }>;
            };
            finish_reason?: string | null;
          }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
        };
        if (data.model) responseModel = data.model;
        if (data.usage) {
          usage = {
            prompt: data.usage.prompt_tokens ?? usage.prompt,
            completion: data.usage.completion_tokens ?? usage.completion,
            total: data.usage.total_tokens ?? usage.total,
          };
        }
        const choice = data.choices?.[0];
        if (choice?.finish_reason !== undefined) finishReason = choice.finish_reason;
        const deltaText = choice?.delta?.content;
        if (deltaText) {
          content += deltaText;
          onDelta({ text: deltaText });
        }
        for (const toolCall of choice?.delta?.tool_calls ?? []) {
          mergeToolCallChunk(toolCalls, toolCall);
        }
      }
    }

    const tail = decoder.decode();
    if (tail) buffered += tail;
    for (const event of parseSseEvents(buffered)) {
      if (event === '[DONE]') continue;
      const data = JSON.parse(event) as {
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      };
      if (data.usage) {
        usage = {
          prompt: data.usage.prompt_tokens ?? usage.prompt,
          completion: data.usage.completion_tokens ?? usage.completion,
          total: data.usage.total_tokens ?? usage.total,
        };
      }
    }
  } finally {
    clearTimeout(timer);
  }

  const completeToolCalls = toolCalls.filter((tc) => tc.id && tc.function.name);
  if (!content && completeToolCalls.length === 0) {
    throw new Error('openrouter returned empty completion');
  }

  return {
    content,
    tool_calls: completeToolCalls.length > 0 ? completeToolCalls : undefined,
    model: responseModel,
    usage,
    finishReason,
  };
}

// Public chat: always prepends the main-LLM XML-sectioned system prompt.
// Supplied messages are appended after ours. Two system turns in the array
// stack (ours first), keeping the public-agent guardrails non-bypassable.
export async function openRouterChatMessages(
  env: Env,
  messages: ChatMessage[],
  opts: CallOptions = {},
): Promise<OpenRouterResult> {
  const raw = await call(env, [mainSystemPrompt(env), ...messages], opts);
  return { reply: raw.content, model: raw.model, usage: raw.usage };
}

// Raw call for the tool-call loop + classifier: caller owns the full message
// list (system turn, tool turns, etc.) and gets the raw assistant message
// including tool_calls. No implicit system prompt is prepended.
export async function openRouterRawCall(
  env: Env,
  messages: ChatMessage[],
  opts: CallOptions = {},
): Promise<RawAssistantMessage> {
  return call(env, messages, opts);
}
