-- Consolidate company_type into company_status, then drop company_type.
--
-- company_status is now the single relationship field (client | target);
-- sector lives in industries[] (the `industry` picklist). The old company_type
-- duplicated client/target and held a couple of sector-ish values.
--
-- Wrapped in a guard so it's a no-op once the column is already gone
-- (idempotent / safe to replay in any environment).
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'companies' and column_name = 'company_type'
  ) then
    -- Relationship values move to company_status where it isn't set yet.
    update public.companies
      set company_status = company_type
      where company_status is null and company_type in ('client', 'target');

    -- Sector-ish value(s) move into industries[].
    update public.companies
      set industries = (
        select array_agg(distinct v)
        from unnest(coalesce(industries, '{}'::text[]) || array['Asset Management']) v
      )
      where company_type = 'Asset Manager';

    alter table public.companies drop column company_type;
  end if;
end $$;
