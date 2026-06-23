-- Harden the MCP `query` tool's read-only SQL helper against secret exfiltration.
--
-- mcp_run_read_query() runs SECURITY DEFINER as the service role, which bypasses
-- RLS. The sandbox is otherwise solid (read-only txn, 8s timeout, 1000-row cap,
-- single statement, search_path pinned), BUT any valid MCP token holder could
-- `select * from app_settings` (provider API keys live there),
-- `select * from integration_accounts` (OAuth access/refresh tokens),
-- `select * from mcp_tokens` (every token hash), or read the auth/vault schemas
-- — i.e. a single leaked recruiter token = full secret exfiltration.
--
-- This adds a deny-guard for those objects as defense-in-depth. It is a
-- belt-and-suspenders text check, not a parser, so the longer-term fix
-- (P1) is to run the statement under a dedicated low-privilege role with
-- SELECT revoked on the secret tables, and to move provider keys into Vault.
-- The text guard is intentionally conservative (word-boundary matched) so it
-- won't trip on ordinary CRM columns like `integration_account_id`.

create or replace function public.mcp_run_read_query(query_text text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  result jsonb;
  cleaned text := btrim(query_text);
begin
  if lower(cleaned) !~ '^(select|with)\s' then
    raise exception 'Only SELECT / WITH queries are allowed';
  end if;
  -- single statement only (a lone trailing semicolon is fine)
  if rtrim(cleaned, ';') ~ ';' then
    raise exception 'Multiple statements are not allowed';
  end if;

  -- Block reads of secret-bearing objects and privileged schemas. service_role
  -- bypasses RLS, so without this any token could exfiltrate API keys / OAuth
  -- tokens / token hashes.
  -- NB: information_schema is intentionally NOT blocked — the describe_schema
  -- MCP tool reads it for column metadata (names/types, not row data), and the
  -- secret-table guard below already prevents reading the actual rows.
  if cleaned ~* '\m(app_settings|integration_accounts|mcp_tokens)\M'
     or cleaned ~* '\m(auth|vault|storage|net|pg_catalog)\s*\.' then
    raise exception 'Query references a restricted object (secret/auth/storage tables are not available via the MCP query tool)';
  end if;

  set local transaction_read_only = on;
  set local statement_timeout = '8000ms';

  execute format(
    'select coalesce(jsonb_agg(t), ''[]''::jsonb) from (select * from (%s) q limit 1000) t',
    rtrim(cleaned, ';')
  ) into result;

  return result;
end;
$$;

revoke all on function public.mcp_run_read_query(text) from public;
revoke all on function public.mcp_run_read_query(text) from anon, authenticated;
grant execute on function public.mcp_run_read_query(text) to service_role;
