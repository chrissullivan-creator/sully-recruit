-- Duplicate interview rows on stage move. ensureInterviewArtifacts did a manual
-- select-then-insert on (send_out_id, round=1) with no DB uniqueness, so two
-- concurrent stage moves — or the updateJobStatus path that could create a
-- second send_out — both saw "no existing row" and both inserted. Enforce
-- idempotency at the database on (candidate_id, job_id, round), which also
-- collapses duplicates created via two different send_outs for the same
-- candidate+job. Additional interview rounds (round 2, 3, …) keep distinct
-- round numbers, so they are unaffected.

-- 1. Collapse existing duplicates, keeping the most complete row per key
--    (a scheduled/decided interview beats an empty stub; then earliest).
with ranked as (
  select id,
         row_number() over (
           partition by candidate_id, job_id, round
           order by (scheduled_at is not null) desc,
                    (outcome is not null) desc,
                    created_at asc nulls last,
                    id asc
         ) as rn
  from public.interviews
  where candidate_id is not null and job_id is not null and round is not null
)
delete from public.interviews i
using ranked r
where i.id = r.id and r.rn > 1;

-- 2. Enforce one interview per (candidate, job, round). Partial so rows missing
--    any key part (rare legacy/ad-hoc interviews) are unconstrained.
create unique index if not exists uniq_interviews_candidate_job_round
  on public.interviews (candidate_id, job_id, round)
  where candidate_id is not null and job_id is not null and round is not null;
