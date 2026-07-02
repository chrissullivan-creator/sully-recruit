-- Keep sequence work idempotent under retries and repeated launches.
--
-- 1) A person should not have more than one live enrollment in the same
--    sequence. Historical stopped/completed enrollments remain available for
--    audit.
-- 2) A single enrollment/action pair should not have more than one open step
--    log. Sent/skipped/failed history stays intact, but duplicate scheduled
--    work is cancelled before the unique index is added.

with ranked_candidate_enrollments as (
  select
    id,
    row_number() over (
      partition by sequence_id, candidate_id
      order by enrolled_at asc nulls last, id asc
    ) as rn
  from public.sequence_enrollments
  where sequence_id is not null
    and candidate_id is not null
    and status in ('active', 'paused')
),
ranked_contact_enrollments as (
  select
    id,
    row_number() over (
      partition by sequence_id, contact_id
      order by enrolled_at asc nulls last, id asc
    ) as rn
  from public.sequence_enrollments
  where sequence_id is not null
    and contact_id is not null
    and status in ('active', 'paused')
),
duplicate_enrollments as (
  select id from ranked_candidate_enrollments where rn > 1
  union
  select id from ranked_contact_enrollments where rn > 1
)
update public.sequence_enrollments se
set
  status = 'stopped',
  stop_trigger = 'duplicate_enrollment',
  stop_reason = 'duplicate_enrollment',
  stopped_at = coalesce(se.stopped_at, now())
from duplicate_enrollments d
where se.id = d.id;

create unique index if not exists sequence_enrollments_one_live_candidate_per_sequence_idx
  on public.sequence_enrollments(sequence_id, candidate_id)
  where sequence_id is not null
    and candidate_id is not null
    and status in ('active', 'paused');

create unique index if not exists sequence_enrollments_one_live_contact_per_sequence_idx
  on public.sequence_enrollments(sequence_id, contact_id)
  where sequence_id is not null
    and contact_id is not null
    and status in ('active', 'paused');

with ranked_open_step_logs as (
  select
    id,
    row_number() over (
      partition by enrollment_id, action_id
      order by scheduled_at asc nulls last, created_at asc nulls last, id asc
    ) as rn
  from public.sequence_step_logs
  where enrollment_id is not null
    and action_id is not null
    and status in ('scheduled', 'pending_connection', 'in_flight')
)
update public.sequence_step_logs sl
set
  status = 'cancelled',
  skip_reason = coalesce(sl.skip_reason, 'duplicate_step_log')
from ranked_open_step_logs r
where sl.id = r.id
  and r.rn > 1;

create unique index if not exists sequence_step_logs_one_open_action_per_enrollment_idx
  on public.sequence_step_logs(enrollment_id, action_id)
  where enrollment_id is not null
    and action_id is not null
    and status in ('scheduled', 'pending_connection', 'in_flight');
