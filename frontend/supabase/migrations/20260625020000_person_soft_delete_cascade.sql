-- Restore-aware soft-delete cascade: deleting a person (people.deleted_at set)
-- also removes them from the pipeline (send_outs, candidate_jobs) and stops
-- their active sequence enrollments — everywhere — and restoring the person
-- reverses exactly that cascade. cascade_deleted_at marks rows the cascade
-- touched (keyed to the person's deleted_at timestamp) so independently
-- deleted rows aren't resurrected on restore.

alter table public.candidate_jobs       add column if not exists deleted_at         timestamptz;
alter table public.candidate_jobs       add column if not exists cascade_deleted_at timestamptz;
alter table public.send_outs            add column if not exists cascade_deleted_at timestamptz;
alter table public.sequence_enrollments add column if not exists cascade_deleted_at timestamptz;

create index if not exists candidate_jobs_deleted_at_idx on public.candidate_jobs (deleted_at);

create or replace function public.fn_cascade_person_soft_delete()
returns trigger
language plpgsql
security definer
set search_path to 'pg_catalog','public'
as $$
begin
  if NEW.deleted_at is not null and OLD.deleted_at is null then
    -- delete cascade
    update public.send_outs
       set deleted_at = NEW.deleted_at, cascade_deleted_at = NEW.deleted_at
     where (candidate_id = NEW.id or contact_id = NEW.id) and deleted_at is null;
    update public.candidate_jobs
       set deleted_at = NEW.deleted_at, cascade_deleted_at = NEW.deleted_at
     where candidate_id = NEW.id and deleted_at is null;
    update public.sequence_enrollments
       set status = 'stopped', cascade_deleted_at = NEW.deleted_at
     where (candidate_id = NEW.id or contact_id = NEW.id) and status = 'active';
  elsif NEW.deleted_at is null and OLD.deleted_at is not null then
    -- restore: only reverse rows this cascade deleted at the same timestamp
    update public.send_outs
       set deleted_at = null, cascade_deleted_at = null
     where (candidate_id = NEW.id or contact_id = NEW.id) and cascade_deleted_at = OLD.deleted_at;
    update public.candidate_jobs
       set deleted_at = null, cascade_deleted_at = null
     where candidate_id = NEW.id and cascade_deleted_at = OLD.deleted_at;
    update public.sequence_enrollments
       set status = 'active', cascade_deleted_at = null
     where (candidate_id = NEW.id or contact_id = NEW.id) and cascade_deleted_at = OLD.deleted_at;
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_cascade_person_soft_delete on public.people;
create trigger trg_cascade_person_soft_delete
  after update of deleted_at on public.people
  for each row execute function public.fn_cascade_person_soft_delete();
