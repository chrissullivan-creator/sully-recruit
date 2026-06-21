-- Read-only SQL escape hatch for the MCP server (/api/mcp `query` tool).
-- PostgREST can't execute arbitrary SELECTs, so this SECURITY DEFINER helper
-- runs a single read-only statement and returns JSON. It is granted ONLY to
-- service_role (the MCP server's key) and revoked from anon/authenticated, so
-- it never becomes an RLS bypass for ordinary app users. The body forces the
-- transaction read-only, caps the result at 1000 rows, and times out at 8s.

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
