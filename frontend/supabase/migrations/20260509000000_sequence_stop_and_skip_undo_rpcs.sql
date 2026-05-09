-- Two RPCs + one constraint widening covering the safety-net actions
-- that the UI was missing.
--
-- The sequences.status check used to only accept
-- {draft, active, paused, archived}, leaving no terminal-by-the-operator
-- state. Pause is reversible; Archive is "hide from list" without
-- promising sends won't fire if you flip it back. Add 'stopped' so the
-- new Stop UI maps to a state that can never silently resume.

alter table public.sequences
  drop constraint if exists sequences_status_check;

alter table public.sequences
  add constraint sequences_status_check
    check (status = any (array[
      'draft'::text,
      'active'::text,
      'paused'::text,
      'archived'::text,
      'stopped'::text
    ]));

-- Two RPCs covering the safety-net actions that the UI was missing:
--
-- 1) stop_sequence(p_sequence_id, p_reason)
--    Bulk-terminates every active enrollment on a sequence and cancels
--    their pending step_logs in a single transaction. The recruiter UI
--    only had Pause + Resume; recruiters had to drop into the DB to
--    actually end a campaign. This RPC matches the engine's existing
--    stop semantics (status='stopped', stop_reason set, scheduled and
--    pending_connection logs flipped to 'cancelled') so reply-stop and
--    operator-stop end up indistinguishable in the data.
--
-- 2) restore_skipped_step(p_step_log_id)
--    Reverses an accidental Skip click on a still-future step. Returns
--    the row count actually restored (0 if the row already fired or the
--    scheduled_at is now in the past, since reversing a real skip would
--    re-send a message we've already deemed irrelevant). Powers the
--    "Undid Skip" toast in the schedule view.

create or replace function public.stop_sequence(
  p_sequence_id uuid,
  p_reason text default 'manual_stop'
)
returns table(stopped_enrollments int, cancelled_step_logs int)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_stopped int;
  v_cancelled int;
begin
  -- Cancel pending sends first so the next sweep tick can't fire them
  -- after we flip the enrollment status.
  with c as (
    update public.sequence_step_logs sl
       set status = 'cancelled',
           updated_at = now()
      from public.sequence_enrollments e
     where sl.enrollment_id = e.id
       and e.sequence_id = p_sequence_id
       and e.status = 'active'
       and sl.status in ('scheduled', 'pending_connection')
    returning sl.id
  )
  select count(*) into v_cancelled from c;

  with s as (
    update public.sequence_enrollments
       set status = 'stopped',
           stopped_at = now(),
           stop_reason = p_reason
     where sequence_id = p_sequence_id
       and status = 'active'
    returning id
  )
  select count(*) into v_stopped from s;

  return query select v_stopped, v_cancelled;
end;
$$;

revoke all on function public.stop_sequence(uuid, text) from public;
grant execute on function public.stop_sequence(uuid, text) to authenticated;

create or replace function public.restore_skipped_step(
  p_step_log_id uuid
)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count int;
begin
  -- Only restore if the step is still in the future. Restoring a past
  -- skip would queue a stale send and re-mail the recipient with no
  -- benefit, since the recruiter already chose to skip it.
  update public.sequence_step_logs
     set status = 'scheduled',
         updated_at = now()
   where id = p_step_log_id
     and status in ('skipped', 'cancelled')
     and scheduled_at > now();
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.restore_skipped_step(uuid) from public;
grant execute on function public.restore_skipped_step(uuid) to authenticated;
