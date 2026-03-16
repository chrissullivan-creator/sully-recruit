-- Atomic processing helper for due sequence enrollments.
CREATE OR REPLACE FUNCTION public.process_due_sequence_step(
  p_enrollment_id uuid,
  p_sequence_step_id uuid,
  p_next_step_order integer,
  p_next_step_at timestamptz,
  p_executed_at timestamptz
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Lock row and make sure the enrollment is still active before advancing.
  PERFORM 1
  FROM public.sequence_enrollments se
  WHERE se.id = p_enrollment_id
    AND se.status = 'active'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Enrollment % is not active or no longer exists', p_enrollment_id;
  END IF;

  INSERT INTO public.sequence_step_executions (
    enrollment_id,
    sequence_step_id,
    status,
    executed_at
  ) VALUES (
    p_enrollment_id,
    p_sequence_step_id,
    'scheduled',
    p_executed_at
  );

  UPDATE public.sequence_enrollments
  SET current_step_order = p_next_step_order,
      next_step_at = p_next_step_at,
      updated_at = now()
  WHERE id = p_enrollment_id;
END;
$$;

-- Atomic helper to mark execution sent and persist provider IDs.
CREATE OR REPLACE FUNCTION public.mark_execution_sent(
  p_execution_id uuid,
  p_executed_at timestamptz,
  p_external_message_id text,
  p_external_conversation_id text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE public.sequence_step_executions
  SET status = 'sent',
      external_message_id = p_external_message_id,
      external_conversation_id = p_external_conversation_id,
      executed_at = p_executed_at
  WHERE id = p_execution_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Execution % not found', p_execution_id;
  END IF;
END;
$$;

-- Daily per-sender send count in America/Chicago business day.
CREATE OR REPLACE FUNCTION public.count_sender_daily_sequence_sends(
  p_sender_id uuid,
  p_now timestamptz DEFAULT now()
)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT COUNT(*)::integer
  FROM public.sequence_step_executions sse
  JOIN public.sequence_enrollments se
    ON se.id = sse.enrollment_id
  WHERE se.enrolled_by = p_sender_id
    AND sse.status = 'sent'
    AND sse.executed_at >= ((p_now AT TIME ZONE 'America/Chicago')::date::timestamp AT TIME ZONE 'America/Chicago')
    AND sse.executed_at <= p_now;
$$;
