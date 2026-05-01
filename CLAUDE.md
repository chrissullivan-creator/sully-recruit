# Sully Recruit — Claude Code Context

## Quick Reference

- **Project:** Sully Recruit CRM/ATS for The Emerald Recruiting Group
- **Supabase project:** `xlobevmhzimxjtpiontf`
- **Repo:** chrissullivan-creator/sully-recruit
- **Deploy:** Push to `main` → Vercel auto-deploys frontend; Trigger.dev auto-deploys tasks

## MCP Servers

All configured in `.mcp.json`. Restart session if disconnected.

- **Supabase** — SQL, migrations, schema (token: supabase.com/dashboard/account/tokens)
- **Trigger.dev** — Task management, schedules, run logs
- **Unipile** — LinkedIn API (DSN: api19.unipile.com:14926)

## Skills

Read these before making changes:

- `claude/SKILL-architecture.md` — DB schema, API patterns, secrets, common mistakes
- `claude/SKILL-frontend.md` — React components, routing, UI patterns
- `claude/SKILL-webhooks.md` — Webhook handlers, Unipile/Microsoft/RingCentral
- `claude/SKILL-sequences.md` — Sequence engine, enrollment logic
- `claude/SKILL-joe.md` — AI assistant (Joe) behavior
- `claude/SKILL-calls.md` — RingCentral call handling

## Key Rules

- All AI calls use **Claude/Anthropic** — no OpenAI, Eden AI, or Lovable gateway
- Unipile API key comes from `app_settings` table via `getAppSetting("UNIPILE_API_KEY")` — NOT from `integration_accounts.access_token`
- Edge function secrets: `ANTHROPIC_API_KEY` (check lowercase fallback `anthropic_api_key`)
- Frontend env vars must be `VITE_*` prefixed
- **Unified person model:** `candidates` table holds BOTH candidates and clients via `type` column (`'candidate'` | `'client'`). The old `contacts` table is now a backwards-compat VIEW over `candidates WHERE type='client'` with INSTEAD OF triggers for writes.
- Person statuses (shared candidate + client): `new`, `reached_out`, `engaged` — nothing else (CHECK constraint enforces this)
- Pipeline stage tables: `pitches`, `send_outs`, `submissions`, `interviews`, `placements`, `rejections`
- Ashley has email and LinkedIn but NO RingCentral — no SMS routing for Ashley
