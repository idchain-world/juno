# Juno Profiles

Profiles live in `profiles/<slug>/` and define voice, identity, optional source context, and optional vibes tests for local iteration.

## Files

- `agent.md`: primary identity, speaking style, and profile rules.
- `soul.md`: lore, background, and persistent self-knowledge.
- `system-prompt.md`: optional replacement for Juno's generic style prose. Runtime capability, tool-discovery, and safety rules always remain active.
- `sources.json`: optional extra static context. Use either an array of paths, or `{ "sources": [{ "key": "name", "path": "file.md" }] }`. Paths must stay inside the profile directory.
- `tests.json`: optional canonical vibes prompts. If absent, `profiles/_default-tests.json` is used.
- `journal/`: generated markdown eval reports from `pnpm vibes`.

## Local Commands

```bash
pnpm dev:profiles slowlava
pnpm profiles:list
pnpm vibes slowlava
pnpm vibes slowlava slowlava-baseline
```

`pnpm dev:profiles <slug>` starts local Juno with the active profile and serves the chat page at `/profiles/chat`. Edits to `agent.md`, `soul.md`, `system-prompt.md`, or `sources.json` reset active sessions and show `Profile reloaded ↻` in the page.

`pnpm vibes <slug>` runs the profile's tests, calls the configured profile model, judges each response with Claude Haiku on OpenRouter, and writes a markdown report to `profiles/<slug>/journal/<timestamp>.md`. On the first solo run it snapshots `profiles/<slug>-baseline/` if that directory does not already exist.

`pnpm vibes <slug-a> <slug-b>` runs A/B and writes a side-by-side report under `profiles/<slug-a>/journal/`.

## Model Defaults

Production Juno reads `OPENROUTER_MODEL` and does not set temperature on `/talk` calls. The local profile scripts preserve that behavior:

- `OPENROUTER_MODEL=google/gemini-2.5-flash` by default
- temperature omitted, so the provider default is used
- `JUNO_VIBES_JUDGE_MODEL=anthropic/claude-3-haiku` by default
