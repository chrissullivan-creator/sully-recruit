-- The picklist array columns (people/jobs.departments+products,
-- companies.industries+strategies) are NOT NULL DEFAULT '{}', but a lot of the
-- app sends an explicit NULL when nothing is selected ("x.length ? x : null"),
-- which trips the NOT NULL constraint and blocks the insert/update — making the
-- field feel "required". Coalesce NULL -> '{}' in a BEFORE trigger so these are
-- never required on any path (add forms, edits, import, MCP), while the column
-- stays a guaranteed non-null array for readers.

create or replace function public.people_coalesce_picklists()
returns trigger language plpgsql as $$
begin
  new.departments := coalesce(new.departments, '{}');
  new.products    := coalesce(new.products, '{}');
  return new;
end $$;

drop trigger if exists trg_people_coalesce_picklists on public.people;
create trigger trg_people_coalesce_picklists
  before insert or update on public.people
  for each row execute function public.people_coalesce_picklists();

create or replace function public.jobs_coalesce_picklists()
returns trigger language plpgsql as $$
begin
  new.departments := coalesce(new.departments, '{}');
  new.products    := coalesce(new.products, '{}');
  return new;
end $$;

drop trigger if exists trg_jobs_coalesce_picklists on public.jobs;
create trigger trg_jobs_coalesce_picklists
  before insert or update on public.jobs
  for each row execute function public.jobs_coalesce_picklists();

create or replace function public.companies_coalesce_picklists()
returns trigger language plpgsql as $$
begin
  new.industries := coalesce(new.industries, '{}');
  new.strategies := coalesce(new.strategies, '{}');
  return new;
end $$;

drop trigger if exists trg_companies_coalesce_picklists on public.companies;
create trigger trg_companies_coalesce_picklists
  before insert or update on public.companies
  for each row execute function public.companies_coalesce_picklists();
