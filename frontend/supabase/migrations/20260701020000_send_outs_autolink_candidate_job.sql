-- Send Out → Submission didn't advance the candidate's live pipeline_stage.
-- ensureSendOut() reads send_outs.candidate_job_id straight off a fresh insert
-- where it's null (nothing populates it), so moveStage() — which only updates
-- candidate_jobs.pipeline_stage when a candidate_job_id is supplied — skipped
-- that write. The funnel's max_pipeline_stage still advanced (its trigger keys
-- on candidate_id/job_id), but the live pipeline_stage stayed put, so the
-- candidate never visibly moved to Submission.
--
-- Fix at the source: auto-link every send_out to its candidate_jobs row on
-- insert (resolve-or-create), so candidate_job_id is always populated for every
-- creation path (in-app SendOut, updateJobStatus, drag-drop, MCP).

create or replace function public.fn_link_send_out_candidate_job()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_cj uuid;
begin
  if NEW.candidate_job_id is null
     and NEW.candidate_id is not null
     and NEW.job_id is not null then
    select id into v_cj
      from public.candidate_jobs
     where candidate_id = NEW.candidate_id and job_id = NEW.job_id
     limit 1;
    if v_cj is null then
      insert into public.candidate_jobs (candidate_id, job_id, pipeline_stage)
      values (NEW.candidate_id, NEW.job_id, 'new')
      returning id into v_cj;
    end if;
    NEW.candidate_job_id := v_cj;
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_link_send_out_candidate_job on public.send_outs;
create trigger trg_link_send_out_candidate_job
  before insert on public.send_outs
  for each row execute function public.fn_link_send_out_candidate_job();

-- Backfill existing send_outs that already have a candidate_jobs row but were
-- never linked, so historical rows also advance correctly on the next move.
update public.send_outs so
   set candidate_job_id = cj.id
  from public.candidate_jobs cj
 where so.candidate_job_id is null
   and so.candidate_id = cj.candidate_id
   and so.job_id = cj.job_id;
