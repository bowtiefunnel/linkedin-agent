# LinkedIn Agent

Daily LinkedIn draft agent, built as a [Trigger.dev](https://trigger.dev) task. Per
project, once a day: drafts a LinkedIn post with an LLM, runs deterministic brand-voice
guardrails and a post-quality guard, then posts a Slack card for human-in-the-loop
Approve/Deny.

Extracted from [bowtiefunnel/agents](https://github.com/bowtiefunnel/agents) (formerly
`agent/subagents/linkedin/`), where it originated and still runs in production.

## Stack

- **Trigger.dev** — scheduled task runtime (`daily-linkedin-drafts-scheduled`)
- **OpenRouter** — LLM drafting
- **Supabase** — project list, review cards, audit log, draft memory
- **Slack** — HITL Approve/Deny review surface
- **Langfuse** (optional) — LLM call tracing/cost observability

## Setup

```bash
npm install
cp .env.example .env   # fill in real keys
npm run typecheck
npm test
```

This repo is currently **unlinked from any Trigger.dev project** (extracted for
ownership/isolation, not yet cut over from prod). To run it standalone:

1. Create a new project in the [Trigger.dev dashboard](https://cloud.trigger.dev).
2. Set `TRIGGER_PROJECT_REF` / `TRIGGER_SECRET_KEY` in `.env`.
3. `npm run dev` (local) or `set -a; . ./.env; set +a; npm run deploy` (prod).

## Layout

```
agent/
  subagents/linkedin/     the agent: daily-linkedin-drafts.ts, lib (linkedin-memory, post-guard)
  connections/            shared clients: openrouter, langfuse, slack, supabase
  lib/                    shared helpers: blocks (Slack card builder), company-context,
                           draft-memory, guardrails, trace
  schemas.ts               shared Zod schemas (Project, AgentPayload)
```

Relative import depth mirrors the parent repo's `agent/` folder exactly, so nothing
was rewritten during extraction.
