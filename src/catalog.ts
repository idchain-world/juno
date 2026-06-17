import type { Env } from './env.js';

export function buildCatalog(env: Env) {
  return {
    restap_version: '0.1.1-beta',
    agent: {
      name: env.agentName,
      description: 'Dappa public agent runtime powered by Juno.',
    },
    capabilities: [
      {
        id: 'talk',
        title: 'Talk to agent',
        method: 'POST',
        endpoint: '/talk',
        description: 'Send a message to the agent and receive an LLM reply.',
        content_types: ['application/json'],
        output_formats: ['application/json', 'text/event-stream'],
        input_schema: {
          type: 'object',
          properties: {
            message: { type: 'string', description: 'Message for the agent.' },
            from: { type: 'string', description: 'Optional caller label.' },
            session_id: { type: 'string', description: 'Optional opaque conversation continuity token.' },
            context: { type: 'object', description: 'Optional request context.' },
          },
          required: ['message'],
        },
        output_schema: {
          type: 'object',
          properties: {
            reply: { type: 'string' },
            session_id: { type: 'string' },
          },
        },
        streaming: {
          supported: true,
          transport: 'sse',
          events: ['message.start', 'message.delta', 'message.end', 'error', 'done'],
        },
        sessions: { supported: true },
      },
      {
        id: 'news',
        title: 'Read news',
        method: 'GET',
        endpoint: '/news',
        description: 'Read stored news items. This endpoint never triggers a reply.',
      },
      {
        id: 'news_receive',
        title: 'Write news',
        method: 'POST',
        endpoint: '/news',
        description: 'Store a news item for the agent. This endpoint never sends an agent reply.',
        content_types: ['application/json'],
      },
      {
        id: 'skill',
        title: 'RESTAP skill',
        method: 'GET',
        endpoint: '/.well-known/skill.md',
        description: 'Optional SKILL.md guidance for clients.',
      },
    ],
    protocols: {
      mcp: { available: true, endpoint: '/mcp' },
      restap: { available: true, endpoint: '/' },
    },
    packages: [
      {
        name: 'Juno RESTAP Skill',
        type: 'claude-skill',
        skill_file: '/.well-known/skill.md',
      },
    ],
    public_url: env.publicUrl,
    endpoints: {
      talk: '/talk',
      news: '/news',
      well_known: '/.well-known/restap.json',
      skill: '/.well-known/skill.md',
      health: '/health',
      identity: '/identity',
      mcp: '/mcp',
    },
    auth: {
      talk: env.protectTalk ? 'bearer' : 'none',
      mcp: 'none',
      news: 'session',
      operator: 'ssh-tunnel',
    },
    limits: {
      max_message_chars: env.maxMessageChars,
      talk_rate_per_min: env.talkRateLimitPerMin,
    },
    // Legacy fields retained for older Dappa/Juno clients that predate the
    // RESTAP catalog shape.
    service_type: 'public-agent',
    version: env.version,
    name: env.agentName,
    legacy_capabilities: ['talk', 'news', 'mcp', 'search_knowledge', 'read_knowledge'],
  };
}
