---
title: Juno Overview
---

# Juno Overview

Juno is a public-facing agent runtime for operating a constrained assistant over HTTP. It exposes a synchronous `/talk` endpoint for external callers, a small operator plane, a safety classifier, request logging, rate limits, and a bounded knowledge-tool loop.

Juno is intentionally generic. Operators provide the agent name, model, public URL, knowledge content, and optional remote knowledge provider settings through environment variables and files.

