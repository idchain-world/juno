---
title: Juno Configuration
---

# Juno Configuration

Juno reads configuration from environment variables. Required settings include `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`, and either `PUBLIC_URL` or `PUBLIC_HOST`.

Knowledge providers are selected with `JUNO_KNOWLEDGE_PROVIDER`. The default `local` mode reads Markdown files from `PUBLIC_AGENT_KNOWLEDGE_DIR`. `remote-http` posts to the configured `JUNO_KNOWLEDGE_API_URL`, which must point to a `/knowledge/query` endpoint. `mcp` connects to `JUNO_MCP_ENDPOINT_URL` after checking that its origin matches `JUNO_MCP_ALLOWED_ORIGIN`.

Operator-specific request metadata can be supplied with `JUNO_CONTEXT_JSON` or individual `JUNO_CONTEXT_*` variables. Juno forwards that context as opaque data and does not interpret its keys.

