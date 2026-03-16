-- Full sequencing audit + repair hardening

ALTER TABLE public.sequence_steps
  ADD CONSTRAINT sequence_steps_step_order_positive_chk
  CHECK (step_order >= 1);

CREATE UNIQUE INDEX IF NOT EXISTS sequence_steps_sequence_id_step_order_uidx
  ON public.sequence_steps(sequence_id, step_order);

CREATE OR REPLACE FUNCTION public.validate_active_enrollment_recipient()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  sequence_channel text;
  recipient_count int;
  candidate_email text;
  contact_email text;
  prospect_email text;
  candidate_phone text;
  contact_phone text;
  prospect_phone text;
BEGIN
  IF NEW.status <> 'active' THEN
    RETURN NEW;
  END IF;

  recipient_count :=
    (CASE WHEN NEW.candidate_id IS NULL THEN 0 ELSE 1 END) +
    (CASE WHEN NEW.contact_id IS NULL THEN 0 ELSE 1 END) +
    (CASE WHEN NEW.prospect_id IS NULL THEN 0 ELSE 1 END);

  IF recipient_count <> 1 THEN
    RAISE EXCEPTION 'Active enrollment must have exactly one recipient entity (candidate/contact/prospect)';
  END IF;

  SELECT channel INTO sequence_channel
  FROM public.sequences
  WHERE id = NEW.sequence_id;

  IF sequence_channel = 'email' THEN
    IF NEW.candidate_id IS NOT NULL THEN
      SELECT email INTO candidate_email FROM public.candidates WHERE id = NEW.candidate_id;
      IF candidate_email IS NULL OR btrim(candidate_email) = '' THEN
        RAISE EXCEPTION 'Active email enrollment candidate is missing email';
      END IF;
    ELSIF NEW.contact_id IS NOT NULL THEN
      SELECT email INTO contact_email FROM public.contacts WHERE id = NEW.contact_id;
      IF contact_email IS NULL OR btrim(contact_email) = '' THEN
        RAISE EXCEPTION 'Active email enrollment contact is missing email';
      END IF;
    ELSE
      SELECT email INTO prospect_email FROM public.prospects WHERE id = NEW.prospect_id;
      IF prospect_email IS NULL OR btrim(prospect_email) = '' THEN
        RAISE EXCEPTION 'Active email enrollment prospect is missing email';
      END IF;
    END IF;
  ELSIF sequence_channel = 'sms' THEN
    IF NEW.candidate_id IS NOT NULL THEN
      SELECT phone INTO candidate_phone FROM public.candidates WHERE id = NEW.candidate_id;
      IF candidate_phone IS NULL OR btrim(candidate_phone) = '' THEN
        RAISE EXCEPTION 'Active sms enrollment candidate is missing phone';
      END IF;
    ELSIF NEW.contact_id IS NOT NULL THEN
      SELECT phone INTO contact_phone FROM public.contacts WHERE id = NEW.contact_id;
      IF contact_phone IS NULL OR btrim(contact_phone) = '' THEN
        RAISE EXCEPTION 'Active sms enrollment contact is missing phone';
      END IF;
    ELSE
      SELECT phone INTO prospect_phone FROM public.prospects WHERE id = NEW.prospect_id;
      IF prospect_phone IS NULL OR btrim(prospect_phone) = '' THEN
        RAISE EXCEPTION 'Active sms enrollment prospect is missing phone';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_active_enrollment_recipient_trigger ON public.sequence_enrollments;
CREATE TRIGGER validate_active_enrollment_recipient_trigger
  BEFORE INSERT OR UPDATE ON public.sequence_enrollments
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_active_enrollment_recipient();

CREATE OR REPLACE FUNCTION public.audit_and_repair_sequences()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  normalized_steps int := 0;
  activated_step_one int := 0;
  failed_bad_recipient int := 0;
  failed_missing_step int := 0;
  active_never_send int := 0;
  missing_or_inactive_step_one int := 0;
  invalid_step_ordering int := 0;
  due_zero_execution int := 0;
  failed_executions int := 0;
  stuck_enrollments int := 0;
BEGIN
  WITH re AS (
    SELECT id, sequence_id,
           row_number() OVER (PARTITION BY sequence_id ORDER BY step_order, created_at, id) AS rn
    FROM public.sequence_steps
  ), upd AS (
    UPDATE public.sequence_steps s
    SET step_order = re.rn
    FROM re
    WHERE s.id = re.id
      AND s.step_order IS DISTINCT FROM re.rn
    RETURNING s.id
  )
  SELECT count(*) INTO normalized_steps FROM upd;

  WITH first_steps AS (
    SELECT DISTINCT ON (sequence_id) id
    FROM public.sequence_steps
    ORDER BY sequence_id, step_order, created_at, id
  ), upd AS (
    UPDATE public.sequence_steps ss
    SET is_active = true
    FROM first_steps fs
    JOIN public.sequences seq ON seq.id = ss.sequence_id
    WHERE ss.id = fs.id
      AND seq.status = 'active'
      AND ss.is_active = false
    RETURNING ss.id
  )
  SELECT count(*) INTO activated_step_one FROM upd;

  -- Fail enrollments with no valid recipient entity
  WITH upd AS (
    UPDATE public.sequence_enrollments e
    SET status = 'failed',
        stopped_reason = 'invalid_or_missing_recipient',
        completed_at = now()
    WHERE e.status = 'active'
      AND (
        (CASE WHEN e.candidate_id IS NULL THEN 0 ELSE 1 END) +
        (CASE WHEN e.contact_id IS NULL THEN 0 ELSE 1 END) +
        (CASE WHEN e.prospect_id IS NULL THEN 0 ELSE 1 END)
      ) <> 1
    RETURNING e.id
  )
  SELECT count(*) INTO failed_bad_recipient FROM upd;

  -- Fail enrollments whose next step does not exist or is inactive
  WITH target AS (
    SELECT e.id
    FROM public.sequence_enrollments e
    LEFT JOIN public.sequence_steps ss
      ON ss.sequence_id = e.sequence_id
     AND ss.step_order = coalesce(e.current_step_order, 0) + 1
     AND ss.is_active = true
    WHERE e.status = 'active'
      AND ss.id IS NULL
  ), upd AS (
    UPDATE public.sequence_enrollments e
    SET status = 'failed',
        stopped_reason = 'missing_or_inactive_step',
        completed_at = now()
    FROM target
    WHERE e.id = target.id
    RETURNING e.id
  )
  SELECT count(*) INTO failed_missing_step FROM upd;

  -- Audit metrics requested
  SELECT count(*) INTO active_never_send
  FROM public.sequence_enrollments e
  WHERE e.status = 'active'
    AND NOT EXISTS (
      SELECT 1 FROM public.sequence_steps s
      WHERE s.sequence_id = e.sequence_id
        AND s.step_order = coalesce(e.current_step_order, 0) + 1
        AND s.is_active = true
    );

  SELECT count(*) INTO missing_or_inactive_step_one
  FROM public.sequences seq
  WHERE seq.status = 'active'
    AND NOT EXISTS (
      SELECT 1 FROM public.sequence_steps s
      WHERE s.sequence_id = seq.id
        AND s.step_order = 1
        AND s.is_active = true
    );

  SELECT count(*) INTO invalid_step_ordering
  FROM (
    SELECT sequence_id,
           min(step_order) AS min_step,
           max(step_order) AS max_step,
           count(*) AS step_count,
           count(DISTINCT step_order) AS distinct_steps
    FROM public.sequence_steps
    GROUP BY sequence_id
  ) x
  WHERE x.min_step <> 1 OR x.max_step <> x.step_count OR x.step_count <> x.distinct_steps;

  SELECT count(*) INTO due_zero_execution
  FROM public.sequence_enrollments e
  WHERE e.status = 'active'
    AND e.next_step_at IS NOT NULL
    AND e.next_step_at <= now()
    AND NOT EXISTS (
      SELECT 1 FROM public.sequence_step_executions ex
      WHERE ex.enrollment_id = e.id
    );

  SELECT count(*) INTO failed_executions
  FROM public.sequence_step_executions
  WHERE status = 'failed';

  SELECT count(*) INTO stuck_enrollments
  FROM public.sequence_enrollments e
  WHERE e.status = 'active'
    AND e.next_step_at IS NOT NULL
    AND e.next_step_at < now()
    AND exists (
      SELECT 1
      FROM public.sequence_step_executions ex
      JOIN public.sequence_steps ss ON ss.id = ex.sequence_step_id
      WHERE ex.enrollment_id = e.id
      GROUP BY ex.enrollment_id
      HAVING max(ss.step_order) = coalesce(e.current_step_order, 0)
    );

  RETURN jsonb_build_object(
    'repaired', jsonb_build_object(
      'normalized_step_order_rows', normalized_steps,
      'activated_step_one_rows', activated_step_one,
      'failed_bad_recipient_enrollments', failed_bad_recipient,
      'failed_missing_step_enrollments', failed_missing_step
    ),
    'audit', jsonb_build_object(
      'active_enrollments_that_can_never_send', active_never_send,
      'sequences_missing_or_inactive_step_1', missing_or_inactive_step_one,
      'sequences_with_invalid_step_ordering', invalid_step_ordering,
      'due_enrollments_with_zero_executions', due_zero_execution,
      'failed_executions', failed_executions,
      'stuck_enrollments_past_next_step_at', stuck_enrollments
    )
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.audit_and_repair_sequences() TO service_role;
