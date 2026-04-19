# Juno

**Juno is a public-facing agent runtime built for the [id-agents](https://github.com/idchain-world/id-agents) framework.** It is the runtime you use when an agent has to talk to callers outside your trusted mesh — a customer's website, a public `/talk` endpoint, a DMZ.

Internal id-agents workers run Claude Code, Codex, or the Claude Agent SDK directly, with full shell and filesystem access. That is fine inside a local team and a liability on the open internet. Juno is the locked-down alternative: a Hono-based Node process with a narrow tool surface, a guard classifier on every turn, a daily token budget, per-IP rate limiting, and optional SSH-tunneled operator endpoints. It is the only id-agents runtime safe to point at the public internet.

## What Juno gives you

- **Narrow capability surface** — the model can only call `search_knowledge` and `read_knowledge`. No shell. No arbitrary file read. No outbound HTTP except OpenRouter.
- **Guard classifier on every turn** — a separate OpenRouter call with a strict refusal schema (violation codes mapped to CWEs). Fails closed on malformed output.
- **Rate limit + daily budget** — per-IP `/talk` rate limit, `MAX_TOKENS_PER_DAY` ceiling, prompt+completion budget reserve before each call.
- **Fail-closed operator plane** — `/inbox`, `/news`, `/mcp` require `PUBLIC_AGENT_AUTH_KEY`. Recommended binding: `127.0.0.1` with operator access via SSH tunnel; public `/talk`, `/health`, `/.well-known/*`, `/identity` on the outer interface.
- **Bounded retrieval loop** — server-side persistence forces deterministic KB query diversity before the model is allowed to say "I don't know."
- **DMZ-deployable** — systemd unit + Caddy reverse proxy on a Hetzner CX22 in Falkenstein, no Docker required. See [`docs/deployment.md`](docs/deployment.md).
- **REST-AP discoverable** — publishes `/.well-known/restap.json` in the schema the id-agents manager expects; registers with `/public add <domain>` on an id-agents CLI.

## Requirements

- Node.js 22+
- An [OpenRouter](https://openrouter.ai) API key
- (Optional, for production) a VPS with SSH access and a domain you control

## Quickstart (local)

```bash
npm install
npm run build

cat > .env <<EOF
OPENROUTER_API_KEY=sk-or-...
OPENROUTER_MODEL=google/gemini-2.5-flash
PUBLIC_AGENT_AUTH_KEY=$(openssl rand -hex 32)
PUBLIC_AGENT_PORT=4200
OPERATOR_PORT=4201
PUBLIC_AGENT_HOST=127.0.0.1
OPERATOR_HOST=127.0.0.1
PUBLIC_URL=http://localhost:4200
PUBLIC_AGENT_KNOWLEDGE_DIR=./knowledge
PUBLIC_AGENT_DATA_DIR=./data
MAX_TOKENS_PER_DAY=100000
EOF

set -a && source .env && set +a
node dist/server.js
```

Then from an id-agents CLI:

```
/public add http://localhost:4200
/public 1
```

## Docs

- [`docs/deployment.md`](docs/deployment.md) — systemd + Caddy on Hetzner
- [`docs/runbook.md`](docs/runbook.md) — day-2 ops: suspend, key rotation, KB rebuild, incident disable
- [`SKILL.md`](SKILL.md) — endpoint contract + human overview

## License

MIT.
