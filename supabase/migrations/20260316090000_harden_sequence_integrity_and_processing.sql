-- Sequence system hardening and repair

-- 1) Enrollment integrity
ALTER TABLE public.sequence_enrollments
  DROP CONSTRAINT IF EXISTS sequence_enrollments_active_recipient_required;

ALTER TABLE public.sequence_enrollments
  ADD CONSTRAINT sequence_enrollments_active_recipient_required
  CHECK (
    status <> 'active'
    OR COALESCE(candidate_id, contact_id, prospect_id) IS NOT NULL
  );

ALTER TABLE public.sequence_enrollments
  DROP CONSTRAINT IF EXISTS sequence_enrollments_single_recipient_guard;

ALTER TABLE public.sequence_enrollments
  ADD CONSTRAINT sequence_enrollments_single_recipient_guard
  CHECK (
    ((candidate_id IS NOT NULL)::int + (contact_id IS NOT NULL)::int + (prospect_id IS NOT NULL)::int) <= 1
  );

-- 2) Step execution must allow explicit malformed failures (no resolvable step)
ALTER TABLE public.sequence_step_executions
  ALTER COLUMN sequence_step_id DROP NOT NULL;

-- 3) Step ordering integrity: no duplicate step orders per sequence
CREATE UNIQUE INDEX IF NOT EXISTS sequence_steps_sequence_order_unique
  ON public.sequence_steps(sequence_id, step_order);

-- 4) Validation helper for sequence activation + active step ordering
CREATE OR REPLACE FUNCTION public.validate_sequence_active_steps(p_sequence_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  active_count integer;
  min_order integer;
  max_order integer;
  distinct_orders integer;
BEGIN
  SELECT COUNT(*), MIN(step_order), MAX(step_order), COUNT(DISTINCT step_order)
  INTO active_count, min_order, max_order, distinct_orders
  FROM public.sequence_steps
  WHERE sequence_id = p_sequence_id
    AND is_active = true;

  IF active_count = 0 THEN
    RAISE EXCEPTION 'Active sequence % must have at least one active step', p_sequence_id;
  END IF;

  IF min_order <> 1 THEN
    RAISE EXCEPTION 'Active sequence % must have active step 1', p_sequence_id;
  END IF;

  IF distinct_orders <> active_count OR max_order <> active_count THEN
    RAISE EXCEPTION 'Active sequence % must have contiguous active step ordering starting at 1', p_sequence_id;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_validate_sequence_on_activate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'active' THEN
    PERFORM public.validate_sequence_active_steps(NEW.id);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sequence_validate_on_activate ON public.sequences;
CREATE TRIGGER sequence_validate_on_activate
  BEFORE INSERT OR UPDATE OF status
  ON public.sequences
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_validate_sequence_on_activate();

CREATE OR REPLACE FUNCTION public.trg_validate_sequence_steps_for_active_sequence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_sequence_id uuid;
  target_sequence_status text;
BEGIN
  target_sequence_id := COALESCE(NEW.sequence_id, OLD.sequence_id);

  SELECT status INTO target_sequence_status
  FROM public.sequences
  WHERE id = target_sequence_id;

  IF target_sequence_status = 'active' THEN
    PERFORM public.validate_sequence_active_steps(target_sequence_id);
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS sequence_steps_validate_for_active_sequence ON public.sequence_steps;
CREATE TRIGGER sequence_steps_validate_for_active_sequence
  BEFORE INSERT OR UPDATE OR DELETE
  ON public.sequence_steps
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_validate_sequence_steps_for_active_sequence();

-- 5) Fail existing broken active enrollments (cannot send)
WITH broken AS (
  SELECT
    se.id,
    se.current_step_order,
    CASE
      WHEN COALESCE(se.candidate_id, se.contact_id, se.prospect_id) IS NULL THEN 'missing recipient on active enrollment'
      WHEN next_step.id IS NULL THEN 'next step is missing or inactive'
      ELSE NULL
    END AS reason,
    next_step.id AS next_step_id
  FROM public.sequence_enrollments se
  LEFT JOIN public.sequence_steps next_step
    ON next_step.sequence_id = se.sequence_id
   AND next_step.step_order = COALESCE(se.current_step_order, 0) + 1
   AND next_step.is_active = true
  WHERE se.status = 'active'
)
INSERT INTO public.sequence_step_executions (
  enrollment_id,
  sequence_step_id,
  status,
  executed_at,
  error_message,
  raw_payload
)
SELECT
  broken.id,
  broken.next_step_id,
  'failed',
  now(),
  broken.reason,
  jsonb_build_object('repair_action', 'marked_failed_by_migration')
FROM broken
WHERE broken.reason IS NOT NULL;

UPDATE public.sequence_enrollments se
SET
  status = 'failed',
  stopped_reason = 'system_repair_failed_enrollment',
  completed_at = now(),
  updated_at = now()
FROM (
  SELECT id
  FROM public.sequence_enrollments
  WHERE status = 'active'
    AND COALESCE(candidate_id, contact_id, prospect_id) IS NULL

  UNION

  SELECT se.id
  FROM public.sequence_enrollments se
  LEFT JOIN public.sequence_steps next_step
    ON next_step.sequence_id = se.sequence_id
   AND next_step.step_order = COALESCE(se.current_step_order, 0) + 1
   AND next_step.is_active = true
  WHERE se.status = 'active'
    AND next_step.id IS NULL
) broken_ids
WHERE se.id = broken_ids.id;
