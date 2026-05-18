---
title: Juno Operations
---

# Juno Operations

Juno stores inbox entries, news, and budget counters under `PUBLIC_AGENT_DATA_DIR`. Operators should set per-instance budget and rate-limit values so a single public endpoint cannot exhaust shared model spend.

Use `PUBLIC_AGENT_AUTH_KEY` to protect operator endpoints. Bind the operator listener to `127.0.0.1` and expose it only through trusted access paths.

