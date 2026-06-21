-- Per-user bearer tokens for the /api/mcp MCP server. Stores only the SHA-256
-- hash of each token and maps it to the recruiter the MCP attributes writes to,
-- so Chris / Nancy / Ashley each get their own attribution from their own
-- ChatGPT connector. Token rows are seeded out-of-band (not in this migration)
-- so raw tokens never live in the repo. Readable only by service_role.

create table if not exists public.mcp_tokens (
  id uuid primary key default gen_random_uuid(),
  token_sha256 text not null unique,
  user_id uuid not null references auth.users(id) on delete cascade,
  label text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);

comment on table public.mcp_tokens is
  'Per-user bearer tokens for the /api/mcp server. Stores only the SHA-256 hash of each token; maps to the recruiter the MCP should attribute writes to. Readable only by service_role (RLS on, no policies).';

alter table public.mcp_tokens enable row level security;
revoke all on public.mcp_tokens from anon, authenticated;
