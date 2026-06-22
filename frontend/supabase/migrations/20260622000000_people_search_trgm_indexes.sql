-- Trigram (pg_trgm) GIN indexes on the people text columns we search on, so
-- ILIKE '%q%' lookups are index-backed instead of full scans. Groundwork for
-- moving list-page search server-side (today most search is client-side over a
-- fully-downloaded table); also speeds the existing email-bypass lookup, the
-- MCP `search` tool, and any ad-hoc `query`.
create extension if not exists pg_trgm;

create index if not exists idx_people_full_name_trgm
  on public.people using gin (full_name gin_trgm_ops);
create index if not exists idx_people_current_company_trgm
  on public.people using gin (current_company gin_trgm_ops);
create index if not exists idx_people_company_name_trgm
  on public.people using gin (company_name gin_trgm_ops);
create index if not exists idx_people_current_title_trgm
  on public.people using gin (current_title gin_trgm_ops);
create index if not exists idx_people_title_trgm
  on public.people using gin (title gin_trgm_ops);
