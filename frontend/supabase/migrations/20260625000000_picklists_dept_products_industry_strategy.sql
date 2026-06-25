-- Shared, admin-editable option lists (Department, Products, Industry, Strategy)
-- + the multi-select value columns they populate on people / jobs / companies.
-- Values are stored as text[] arrays of the chosen option strings; the option
-- lists themselves live in picklist_options and are edited in Settings → Admin.

create table if not exists public.picklist_options (
  id uuid primary key default gen_random_uuid(),
  category text not null check (category in ('department','products','industry','strategy')),
  value text not null,
  sort_order int not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index if not exists picklist_options_cat_val_uniq
  on public.picklist_options (category, lower(value));

alter table public.people    add column if not exists departments text[] not null default '{}';
alter table public.people    add column if not exists products    text[] not null default '{}';
alter table public.jobs      add column if not exists departments text[] not null default '{}';
alter table public.jobs      add column if not exists products    text[] not null default '{}';
alter table public.companies add column if not exists industries  text[] not null default '{}';
alter table public.companies add column if not exists strategies  text[] not null default '{}';

-- backfill the existing single department text into the new array
update public.people
   set departments = array[department]
 where department is not null and btrim(department) <> ''
   and (departments is null or departments = '{}');

insert into public.picklist_options (category, value, sort_order) values
  ('department','Portfolio Management',1),
  ('department','Quantitative Research',2),
  ('department','Market Risk',3),
  ('department','Credit Risk',4),
  ('department','Operational Risk',5),
  ('products','Equities',1),
  ('products','Futures',2),
  ('products','Credit',3),
  ('products','Interest Rates',4),
  ('products','FX',5),
  ('industry','Asset Management',1),
  ('industry','Investment Bank',2),
  ('industry','Hedge Fund',3),
  ('strategy','Macro',1),
  ('strategy','Quant',2),
  ('strategy','Equities',3)
on conflict do nothing;

alter table public.picklist_options enable row level security;
drop policy if exists picklist_options_read on public.picklist_options;
create policy picklist_options_read on public.picklist_options
  for select to authenticated using (true);
drop policy if exists picklist_options_write on public.picklist_options;
create policy picklist_options_write on public.picklist_options
  for all to authenticated using (true) with check (true);
