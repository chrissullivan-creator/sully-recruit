-- ============================================================================
-- Lead sub-stages: a mini-pipeline WITHIN the jobs.status = 'lead' state.
--   new -> contacts_added -> reached_out -> market_over   (then "Convert to Hot"
--   sets status='hot' and the sub-stage stops applying).
-- "Convert to Hot" is an action, not a stored value. Sub-stage only applies
-- while status='lead'.
--
-- Auto-advance (forward-only; never downgrades; only while status='lead'):
--   * a job_contacts row is added              -> contacts_added
--   * an OUTBOUND email/LinkedIn msg to a       -> reached_out
--     job's contact
--   * a send_out (candidate tied to the job)    -> market_over
-- ============================================================================

alter table public.jobs
  add column if not exists lead_stage text default 'new';

alter table public.jobs drop constraint if exists jobs_lead_stage_check;
alter table public.jobs add constraint jobs_lead_stage_check
  check (lead_stage is null or lead_stage in ('new','contacts_added','reached_out','market_over'));

-- Existing leads start at 'new'; non-leads carry no sub-stage.
update public.jobs set lead_stage = 'new'  where status =  'lead' and lead_stage is null;
update public.jobs set lead_stage = null   where status <> 'lead';

-- Forward-only setter: bump a lead's sub-stage up to p_target, never back, and
-- only while the job is still a 'lead'.
create or replace function public.advance_job_lead_stage(p_job_id uuid, p_target text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  rank_of constant jsonb := '{"new":0,"contacts_added":1,"reached_out":2,"market_over":3}'::jsonb;
  target_rank int;
begin
  if p_job_id is null then return; end if;
  target_rank := (rank_of ->> p_target)::int;
  if target_rank is null then return; end if;

  update public.jobs j
     set lead_stage = p_target,
         updated_at = now()
   where j.id = p_job_id
     and j.status = 'lead'
     and coalesce((rank_of ->> coalesce(j.lead_stage,'new'))::int, 0) < target_rank;
end;
$$;

-- ── contacts added -> contacts_added ────────────────────────────────────────
create or replace function public.trg_lead_stage_on_job_contact()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  begin
    perform public.advance_job_lead_stage(new.job_id, 'contacts_added');
  exception when others then null;  -- never block the contact link
  end;
  return new;
end; $$;

drop trigger if exists lead_stage_on_job_contact on public.job_contacts;
create trigger lead_stage_on_job_contact
  after insert on public.job_contacts
  for each row execute function public.trg_lead_stage_on_job_contact();

-- ── send-out (candidate tied to the job) -> market_over ─────────────────────
create or replace function public.trg_lead_stage_on_send_out()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  begin
    perform public.advance_job_lead_stage(new.job_id, 'market_over');
  exception when others then null;
  end;
  return new;
end; $$;

drop trigger if exists lead_stage_on_send_out on public.send_outs;
create trigger lead_stage_on_send_out
  after insert on public.send_outs
  for each row execute function public.trg_lead_stage_on_send_out();

-- ── outbound email/LinkedIn to a job's contact -> reached_out ───────────────
-- A candidate-tied send_out_id routes to market_over instead. Calls excluded.
create or replace function public.trg_lead_stage_on_message()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  begin
    if new.send_out_id is not null then
      perform public.advance_job_lead_stage(
        (select job_id from public.send_outs where id = new.send_out_id), 'market_over');
    elsif new.contact_id is not null then
      perform public.advance_job_lead_stage(jc.job_id, 'reached_out')
        from public.job_contacts jc
       where jc.contact_id = new.contact_id;
    end if;
  exception when others then null;  -- never block message ingestion
  end;
  return new;
end; $$;

drop trigger if exists lead_stage_on_message on public.messages;
create trigger lead_stage_on_message
  after insert on public.messages
  for each row
  when (
    lower(coalesce(new.direction,'')) = 'outbound'
    and coalesce(new.channel,'') <> 'call'
    and (new.contact_id is not null or new.send_out_id is not null)
  )
  execute function public.trg_lead_stage_on_message();

-- ── Smart backfill: seed existing leads from their history (forward-only) ────
update public.jobs j set lead_stage = 'contacts_added'
 where j.status = 'lead' and j.lead_stage = 'new'
   and exists (select 1 from public.job_contacts jc where jc.job_id = j.id);

update public.jobs j set lead_stage = 'reached_out'
 where j.status = 'lead' and j.lead_stage in ('new','contacts_added')
   and exists (
     select 1 from public.messages m
       join public.job_contacts jc on jc.contact_id = m.contact_id
      where jc.job_id = j.id
        and lower(coalesce(m.direction,'')) = 'outbound'
        and coalesce(m.channel,'') <> 'call'
   );

update public.jobs j set lead_stage = 'market_over'
 where j.status = 'lead' and j.lead_stage in ('new','contacts_added','reached_out')
   and exists (select 1 from public.send_outs s where s.job_id = j.id and s.deleted_at is null);
