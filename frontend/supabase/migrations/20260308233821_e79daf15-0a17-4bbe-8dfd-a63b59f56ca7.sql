-- Create call_logs table to track all calls
CREATE TABLE public.call_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  phone_number text NOT NULL,
  direction text NOT NULL DEFAULT 'outbound',
  duration_seconds integer,
  started_at timestamp with time zone NOT NULL DEFAULT now(),
  ended_at timestamp with time zone,
  status text NOT NULL DEFAULT 'in_progress',
  notes text,
  summary text,
  audio_url text,
  external_call_id text,
  -- Linked entity (auto-matched or manually set)
  linked_entity_type text,
  linked_entity_id uuid,
  linked_entity_name text,
  -- Timestamps
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.call_logs ENABLE ROW LEVEL SECURITY;

-- RLS policies: users can manage their own calls
CREATE POLICY "Users manage own call_logs"
  ON public.call_logs FOR ALL TO authenticated
  USING (owner_id = auth.uid())
  WITH CHECK (owner_id = auth.uid());

-- All authenticated users can read all calls (for team visibility)
CREATE POLICY "Users read all call_logs"
  ON public.call_logs FOR SELECT TO authenticated
  USING (true);

-- Add trigger for updated_at
CREATE TRIGGER set_call_logs_updated_at
  BEFORE UPDATE ON public.call_logs
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- Add trigger to auto-set owner_id
CREATE TRIGGER set_call_logs_owner
  BEFORE INSERT ON public.call_logs
  FOR EACH ROW
  EXECUTE FUNCTION public.set_owner();

-- Function to match phone number and link entity
CREATE OR REPLACE FUNCTION public.match_phone_and_link_call(
  p_call_id uuid,
  p_phone_number text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_entity_type text;
  v_entity_id uuid;
  v_entity_name text;
  v_normalized_phone text;
  v_candidate candidates;
BEGIN
  -- Normalize phone number (remove non-digits except leading +)
  v_normalized_phone := regexp_replace(p_phone_number, '[^0-9+]', '', 'g');
  
  -- Try to match candidate first
  SELECT id, full_name INTO v_entity_id, v_entity_name
  FROM candidates
  WHERE regexp_replace(phone, '[^0-9+]', '', 'g') = v_normalized_phone
  LIMIT 1;
  
  IF v_entity_id IS NOT NULL THEN
    v_entity_type := 'candidate';
  ELSE
    -- Try to match contact
    SELECT id, full_name INTO v_entity_id, v_entity_name
    FROM contacts
    WHERE regexp_replace(phone, '[^0-9+]', '', 'g') = v_normalized_phone
    LIMIT 1;
    
    IF v_entity_id IS NOT NULL THEN
      v_entity_type := 'contact';
    END IF;
  END IF;
  
  -- Update the call_log with matched entity
  IF v_entity_id IS NOT NULL THEN
    UPDATE call_logs
    SET linked_entity_type = v_entity_type,
        linked_entity_id = v_entity_id,
        linked_entity_name = v_entity_name
    WHERE id = p_call_id;
  END IF;
  
  RETURN jsonb_build_object(
    'matched', v_entity_id IS NOT NULL,
    'entity_type', v_entity_type,
    'entity_id', v_entity_id,
    'entity_name', v_entity_name
  );
END;
$$;

-- Function to complete a call, add notes, and promote prospect if needed
CREATE OR REPLACE FUNCTION public.complete_call_with_notes(
  p_call_id uuid,
  p_notes text,
  p_summary text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_call call_logs;
  v_new_candidate candidates;
  v_result jsonb;
BEGIN
  -- Get the call
  SELECT * INTO v_call FROM call_logs WHERE id = p_call_id;
  
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Call not found');
  END IF;
  
  -- Update the call with notes
  UPDATE call_logs
  SET notes = p_notes,
      summary = p_summary,
      status = 'completed',
      ended_at = COALESCE(ended_at, now())
  WHERE id = p_call_id;
  
  -- Create a note record linked to the entity
  IF v_call.linked_entity_id IS NOT NULL AND v_call.linked_entity_type IS NOT NULL THEN
    INSERT INTO notes (entity_id, entity_type, note, created_by)
    VALUES (
      v_call.linked_entity_id,
      v_call.linked_entity_type,
      'Call Notes: ' || p_notes,
      auth.uid()::text
    );
    
    -- No prospects table: skip promotion logic
    -- (previously would promote a prospect to candidate)
    
    NULL;
  END IF;
  
  RETURN jsonb_build_object('success', true, 'promoted_to_candidate', false);
END;
$$;