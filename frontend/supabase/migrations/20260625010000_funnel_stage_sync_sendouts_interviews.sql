-- Sync the furthest pipeline stage reached on send_outs / interviews into
-- candidate_jobs.max_pipeline_stage (the column the job funnel stats read).
-- Previously a send-out/interview advance only wrote candidates.job_status, so
-- the funnel (QuickStats, reading candidate_jobs) never saw it — a candidate
-- moved straight to Interview still showed as Submitted. Ratchet-UP only:
-- never lowers a stage, so it's safe and restore-neutral.

create or replace function public.fn_bump_candidate_job_max_stage(p_candidate_id uuid, p_job_id uuid, p_stage text)
returns void
language plpgsql
security definer
set search_path to 'pg_catalog','public'
as $$
declare r int := public.pipeline_funnel_rank(p_stage);
begin
  if r is null or p_candidate_id is null or p_job_id is null then return; end if;
  update public.candidate_jobs cj
     set max_pipeline_stage = public.pipeline_funnel_key(r)
   where cj.candidate_id = p_candidate_id and cj.job_id = p_job_id
     and coalesce(public.pipeline_funnel_rank(cj.max_pipeline_stage), -1) < r;
end;
$$;

create or replace function public.fn_sync_sendout_stage_to_candidate_job()
returns trigger
language plpgsql
security definer
set search_path to 'pg_catalog','public'
as $$
begin
  if NEW.candidate_id is not null and NEW.job_id is not null then
    perform public.fn_bump_candidate_job_max_stage(NEW.candidate_id, NEW.job_id, NEW.stage);
  end if;
  return NEW;
end;
$$;
drop trigger if exists trg_sync_sendout_stage_to_cj on public.send_outs;
create trigger trg_sync_sendout_stage_to_cj
  after insert or update of stage on public.send_outs
  for each row execute function public.fn_sync_sendout_stage_to_candidate_job();

create or replace function public.fn_sync_interview_to_candidate_job()
returns trigger
language plpgsql
security definer
set search_path to 'pg_catalog','public'
as $$
begin
  if NEW.candidate_id is not null and NEW.job_id is not null then
    perform public.fn_bump_candidate_job_max_stage(NEW.candidate_id, NEW.job_id, 'interview');
  end if;
  return NEW;
end;
$$;
drop trigger if exists trg_sync_interview_to_cj on public.interviews;
create trigger trg_sync_interview_to_cj
  after insert on public.interviews
  for each row execute function public.fn_sync_interview_to_candidate_job();

-- Backfill existing rows from their send_outs + interviews.
update public.candidate_jobs cj
   set max_pipeline_stage = public.pipeline_funnel_key(sub.maxrank)
  from (
    select cj2.id,
           greatest(
             coalesce(public.pipeline_funnel_rank(cj2.max_pipeline_stage), -1),
             coalesce((select max(public.pipeline_funnel_rank(so.stage))
                         from public.send_outs so
                        where so.candidate_id = cj2.candidate_id and so.job_id = cj2.job_id
                          and so.deleted_at is null), -1),
             case when exists (select 1 from public.interviews iv
                                where iv.candidate_id = cj2.candidate_id and iv.job_id = cj2.job_id)
                  then 3 else -1 end
           ) as maxrank
      from public.candidate_jobs cj2
  ) sub
 where cj.id = sub.id
   and sub.maxrank >= 0
   and coalesce(public.pipeline_funnel_rank(cj.max_pipeline_stage), -1) < sub.maxrank;
