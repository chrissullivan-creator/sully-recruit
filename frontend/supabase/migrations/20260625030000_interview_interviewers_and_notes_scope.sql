-- Interviewers (the people the candidate meets with) as a many-to-many so an
-- interview is also discoverable from a contact's record. The primary one stays
-- mirrored to interviews.interviewer_contact_id for the existing denormalized cols.
create table if not exists public.interview_interviewers (
  id uuid primary key default gen_random_uuid(),
  interview_id uuid not null references public.interviews(id) on delete cascade,
  contact_id   uuid not null references public.people(id)     on delete cascade,
  is_primary   boolean not null default false,
  created_at   timestamptz not null default now(),
  unique (interview_id, contact_id)
);
create index if not exists interview_interviewers_interview_idx on public.interview_interviewers(interview_id);
create index if not exists interview_interviewers_contact_idx   on public.interview_interviewers(contact_id);

alter table public.interview_interviewers enable row level security;
drop policy if exists interview_interviewers_rw on public.interview_interviewers;
create policy interview_interviewers_rw on public.interview_interviewers
  for all to authenticated using (true) with check (true);

-- Let interview prep notes reuse the shared polymorphic notes table.
do $$
declare cname text;
begin
  select conname into cname from pg_constraint
   where conrelid = 'public.notes'::regclass and contype = 'c'
     and pg_get_constraintdef(oid) ilike '%entity_type%'
   limit 1;
  if cname is not null then
    execute format('alter table public.notes drop constraint %I', cname);
  end if;
  alter table public.notes add constraint notes_entity_type_check
    check (entity_type = any (array['prospect','candidate','contact','company','job','send_out','interview']));
end $$;
