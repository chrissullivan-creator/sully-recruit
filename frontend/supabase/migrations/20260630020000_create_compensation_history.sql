-- Point-in-time compensation snapshots for a person. Recruiters capture what a
-- candidate is currently earning + what they're asking for at periodic points
-- so the conversation history ("in March they wanted 250 base, now 300") is
-- never lost when the live people.*_comp fields are overwritten.
create table if not exists public.compensation_history (
  id                  uuid primary key default gen_random_uuid(),
  person_id           uuid not null references public.people(id) on delete cascade,
  recorded_at         timestamptz not null default now(),
  current_base_comp   numeric,
  current_bonus_comp  numeric,
  current_total_comp  numeric,
  target_base_comp    numeric,
  target_bonus_comp   numeric,
  target_total_comp   numeric,
  note                text,
  created_by          uuid,
  created_at          timestamptz not null default now()
);

create index if not exists compensation_history_person_idx
  on public.compensation_history (person_id, recorded_at desc);

alter table public.compensation_history enable row level security;

drop policy if exists compensation_history_rw on public.compensation_history;
create policy compensation_history_rw on public.compensation_history
  for all to authenticated using (true) with check (true);

comment on table public.compensation_history is
  'Point-in-time comp snapshots per person (current + target base/bonus/total + note). Manual recruiter entries; the live numbers stay on people.*_comp.';
