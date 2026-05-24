-- Phase 5d: fold calls into the unified communication hub.
--
-- 1. Relax conversations.channel CHECK to allow 'call'
-- 2. Trigger on call_logs (and ai_call_notes touch) keeps conversations
--    + messages in sync with each call.
-- 3. Pre-existing trg_stop_enrollments_on_reply function had stale
--    column names (stopped_reason → stop_reason, dropped next_step_at);
--    fixed here so the inbound-call message insert doesn't crash and
--    so the existing-channel webhook handlers still work.

ALTER TABLE public.conversations
  DROP CONSTRAINT IF EXISTS conversations_channel_check;
ALTER TABLE public.conversations
  ADD CONSTRAINT conversations_channel_check
  CHECK (channel = ANY (ARRAY['linkedin','linkedin_recruiter','linkedin_sales_nav','email','sms','call']));

-- Fix the broken pre-existing trigger.
CREATE OR REPLACE FUNCTION public.stop_enrollments_on_reply()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, extensions
AS $$
BEGIN
  IF NEW.direction != 'inbound' THEN
    RETURN NEW;
  END IF;
  IF NEW.candidate_id IS NULL AND NEW.contact_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.message_type = 'connection_accepted' THEN
    IF NEW.candidate_id IS NOT NULL THEN
      UPDATE sequence_enrollments
      SET linkedin_connection_accepted_at = NOW(),
          linkedin_connection_status = 'accepted',
          updated_at = NOW()
      WHERE candidate_id = NEW.candidate_id
        AND linkedin_connection_status = 'pending';
    END IF;
    IF NEW.contact_id IS NOT NULL THEN
      UPDATE sequence_enrollments
      SET linkedin_connection_accepted_at = NOW(),
          linkedin_connection_status = 'accepted',
          updated_at = NOW()
      WHERE contact_id = NEW.contact_id
        AND linkedin_connection_status = 'pending';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.candidate_id IS NOT NULL THEN
    UPDATE sequence_enrollments
    SET status = 'stopped',
        stop_reason = 'reply_received',
        stop_trigger = 'reply_received',
        stopped_at = NOW(),
        updated_at = NOW()
    WHERE candidate_id = NEW.candidate_id
      AND status = 'active';
  END IF;
  IF NEW.contact_id IS NOT NULL THEN
    UPDATE sequence_enrollments
    SET status = 'stopped',
        stop_reason = 'reply_received',
        stop_trigger = 'reply_received',
        stopped_at = NOW(),
        updated_at = NOW()
    WHERE contact_id = NEW.contact_id
      AND status = 'active';
  END IF;

  RETURN NEW;
END;
$$;

-- Sync call_logs → conversations + messages
CREATE OR REPLACE FUNCTION public.sync_call_log_to_conversation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_body text;
  v_subject text;
  v_ai_summary text;
BEGIN
  SELECT n.ai_summary INTO v_ai_summary
    FROM public.ai_call_notes n
    WHERE n.call_log_id = NEW.id
    ORDER BY n.created_at DESC LIMIT 1;

  v_body := COALESCE(NULLIF(v_ai_summary, ''), NULLIF(NEW.summary, ''), NULLIF(NEW.notes, ''), '');
  v_subject := 'Call · ' || COALESCE(NEW.linked_entity_name, NEW.phone_number, 'Unknown number');

  INSERT INTO public.conversations (
    id, channel, candidate_id, contact_id, owner_id,
    external_conversation_id, subject,
    last_message_at, last_message_preview,
    is_read, account_id, created_at, updated_at
  ) VALUES (
    NEW.id, 'call', NEW.candidate_id, NEW.contact_id, NEW.owner_id,
    NULLIF(NEW.external_call_id, ''),
    v_subject,
    COALESCE(NEW.ended_at, NEW.started_at, NEW.created_at),
    left(v_body, 200),
    true, NEW.phone_number,
    NEW.created_at, now()
  )
  ON CONFLICT (id) DO UPDATE SET
    candidate_id = EXCLUDED.candidate_id,
    contact_id = EXCLUDED.contact_id,
    subject = EXCLUDED.subject,
    last_message_at = EXCLUDED.last_message_at,
    last_message_preview = EXCLUDED.last_message_preview,
    updated_at = now();

  -- Use a WHERE NOT EXISTS pattern instead of ON CONFLICT because the
  -- (provider, external_message_id) uniqueness is enforced by a partial
  -- index, which ON CONFLICT can't target.
  IF NOT EXISTS (
    SELECT 1 FROM public.messages m
    WHERE m.provider = 'ringcentral' AND m.external_message_id = NEW.id::text
  ) THEN
    INSERT INTO public.messages (
      conversation_id, candidate_id, contact_id, channel, direction,
      body, sent_at,
      sender_address, recipient_address,
      owner_id, external_message_id, provider, created_at
    ) VALUES (
      NEW.id, NEW.candidate_id, NEW.contact_id, 'call',
      COALESCE(NEW.direction, 'inbound'),
      v_body,
      COALESCE(NEW.started_at, NEW.created_at),
      CASE WHEN COALESCE(NEW.direction,'inbound') = 'inbound' THEN NEW.phone_number ELSE NULL END,
      CASE WHEN COALESCE(NEW.direction,'inbound') = 'outbound' THEN NEW.phone_number ELSE NULL END,
      NEW.owner_id, NEW.id::text, 'ringcentral', NEW.created_at
    );
  ELSE
    UPDATE public.messages
    SET body = v_body, sent_at = COALESCE(NEW.started_at, NEW.created_at), updated_at = now()
    WHERE provider = 'ringcentral' AND external_message_id = NEW.id::text;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sync_call_log_to_conversation_trg ON public.call_logs;
CREATE TRIGGER sync_call_log_to_conversation_trg
AFTER INSERT OR UPDATE OF candidate_id, contact_id, summary, notes, ended_at, direction
ON public.call_logs
FOR EACH ROW
EXECUTE FUNCTION public.sync_call_log_to_conversation();

-- When ai_call_notes is created/updated, touch call_logs to re-fire
-- the sync trigger so the AI summary lands in messages.body.
CREATE OR REPLACE FUNCTION public.sync_ai_call_note_to_message()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.call_log_id IS NULL OR COALESCE(NEW.ai_summary, '') = '' THEN
    RETURN NEW;
  END IF;
  UPDATE public.call_logs SET updated_at = now() WHERE id = NEW.call_log_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sync_ai_call_note_to_message_trg ON public.ai_call_notes;
CREATE TRIGGER sync_ai_call_note_to_message_trg
AFTER INSERT OR UPDATE OF ai_summary, structured_notes
ON public.ai_call_notes
FOR EACH ROW
EXECUTE FUNCTION public.sync_ai_call_note_to_message();
