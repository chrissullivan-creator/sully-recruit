-- Correct the market_over rule: a candidate merely tagged or sent isn't enough.
-- It must have reached SUBMISSION stage (submitted/sent) or beyond on the job.
-- Drive market_over off candidate_jobs (the canonical per candidate-job pipeline
-- tracker), not "any send_out exists" — which over-counted pitch/ready_to_send.

-- 1. Retire the too-broad send_outs INSERT -> market_over trigger.
drop trigger if exists lead_stage_on_send_out on public.send_outs;
drop function if exists public.trg_lead_stage_on_send_out();

-- 2. Messages trigger now drives reached_out ONLY (outbound to a job contact).
create or replace function public.trg_lead_stage_on_message()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  begin
    if new.contact_id is not null then
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
    and new.contact_id is not null
  )
  execute function public.trg_lead_stage_on_message();

-- 3. Submission signal: a candidate reaches submitted+ on the job -> market_over.
--    'ready_to_send' / 'pitch' are BEFORE submission and intentionally excluded.
create or replace function public.trg_lead_stage_on_candidate_job()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  begin
    if lower(coalesce(new.max_pipeline_stage, new.pipeline_stage, '')) in
       ('submitted','sent','interview','interviewing','interview_round_1',
        'interview_round_2_plus','offer','offer_made','placed') then
      perform public.advance_job_lead_stage(new.job_id, 'market_over');
    end if;
  exception when others then null;
  end;
  return new;
end; $$;

drop trigger if exists lead_stage_on_candidate_job on public.candidate_jobs;
create trigger lead_stage_on_candidate_job
  after insert or update of pipeline_stage, max_pipeline_stage on public.candidate_jobs
  for each row execute function public.trg_lead_stage_on_candidate_job();

-- 4. Recompute every lead's sub-stage from the corrected rules (one-time; the
--    feature is brand new so there are no manual edits to clobber). Highest
--    matching stage wins; this drops the over-counted market_overs back down.
update public.jobs j set lead_stage = sub.stage, updated_at = now()
from (
  select j2.id,
    case
      when exists (
        select 1 from public.candidate_jobs cj
         where cj.job_id = j2.id
           and lower(coalesce(cj.max_pipeline_stage, cj.pipeline_stage,'')) in
             ('submitted','sent','interview','interviewing','interview_round_1',
              'interview_round_2_plus','offer','offer_made','placed')
      ) then 'market_over'
      when exists (
        select 1 from public.messages m
          join public.job_contacts jc on jc.contact_id = m.contact_id
         where jc.job_id = j2.id
           and lower(coalesce(m.direction,'')) = 'outbound'
           and coalesce(m.channel,'') <> 'call'
      ) then 'reached_out'
      when exists (select 1 from public.job_contacts jc where jc.job_id = j2.id)
        then 'contacts_added'
      else 'new'
    end as stage
  from public.jobs j2
  where j2.status = 'lead'
) sub
where sub.id = j.id and coalesce(j.lead_stage,'') <> sub.stage;
