-- Create sequences table
CREATE TABLE public.sequences (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  channel TEXT NOT NULL DEFAULT 'email',
  status TEXT NOT NULL DEFAULT 'draft',
  stop_on_reply BOOLEAN NOT NULL DEFAULT true,
  job_id UUID REFERENCES public.jobs(id) ON DELETE SET NULL,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Create sequence_steps table
CREATE TABLE public.sequence_steps (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  sequence_id UUID NOT NULL REFERENCES public.sequences(id) ON DELETE CASCADE,
  step_order INTEGER NOT NULL,
  step_type TEXT NOT NULL DEFAULT 'email',
  channel TEXT,
  subject TEXT,
  body TEXT,
  delay_days INTEGER NOT NULL DEFAULT 0,
  delay_hours INTEGER NOT NULL DEFAULT 0,
  send_window_start INTEGER NOT NULL DEFAULT 6,
  send_window_end INTEGER NOT NULL DEFAULT 23,
  wait_for_connection BOOLEAN NOT NULL DEFAULT false,
  min_hours_after_connection INTEGER NOT NULL DEFAULT 4,
  require_connection BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true,
  is_reply BOOLEAN NOT NULL DEFAULT false,
  use_signature BOOLEAN NOT NULL DEFAULT false,
  account_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Create send_outs table
CREATE TABLE public.send_outs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  candidate_id UUID NOT NULL REFERENCES public.candidates(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES public.contacts(id) ON DELETE SET NULL,
  job_id UUID NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  recruiter_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  stage TEXT NOT NULL DEFAULT 'lead',
  outcome TEXT,
  sent_to_client_at TIMESTAMPTZ,
  interview_at TIMESTAMPTZ,
  offer_at TIMESTAMPTZ,
  placed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Create sequence_enrollments table
CREATE TABLE public.sequence_enrollments (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  sequence_id UUID NOT NULL REFERENCES public.sequences(id) ON DELETE CASCADE,
  candidate_id UUID REFERENCES public.candidates(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES public.contacts(id) ON DELETE CASCADE,
  send_out_id UUID REFERENCES public.send_outs(id) ON DELETE SET NULL,
  enrolled_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  account_id UUID,
  status TEXT NOT NULL DEFAULT 'active',
  current_step_order INTEGER,
  enrolled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  next_step_at TIMESTAMPTZ,
  paused_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  stopped_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Create sequence_step_executions table
CREATE TABLE public.sequence_step_executions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  enrollment_id UUID NOT NULL REFERENCES public.sequence_enrollments(id) ON DELETE CASCADE,
  sequence_step_id UUID NOT NULL REFERENCES public.sequence_steps(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  executed_at TIMESTAMPTZ,
  error_message TEXT,
  external_message_id TEXT,
  external_conversation_id TEXT,
  raw_payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Create candidate_channels table
CREATE TABLE public.candidate_channels (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  candidate_id UUID NOT NULL REFERENCES public.candidates(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  provider_id TEXT,
  provider_public_id TEXT,
  unipile_id TEXT,
  external_conversation_id TEXT,
  is_connected BOOLEAN NOT NULL DEFAULT false,
  connected_at TIMESTAMPTZ,
  last_inbound_at TIMESTAMPTZ,
  last_outbound_at TIMESTAMPTZ,
  account_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Create contact_channels table
CREATE TABLE public.contact_channels (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  contact_id UUID NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  provider_id TEXT,
  provider_public_id TEXT,
  unipile_id TEXT,
  external_conversation_id TEXT,
  is_connected BOOLEAN NOT NULL DEFAULT false,
  connected_at TIMESTAMPTZ,
  last_inbound_at TIMESTAMPTZ,
  last_outbound_at TIMESTAMPTZ,
  account_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Create conversations table
CREATE TABLE public.conversations (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  candidate_id UUID REFERENCES public.candidates(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES public.contacts(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  external_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  last_message_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Create messages table
CREATE TABLE public.messages (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  direction TEXT NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at TIMESTAMPTZ,
  read_at TIMESTAMPTZ,
  external_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Create notes table
CREATE TABLE public.notes (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  entity_id UUID NOT NULL,
  entity_type TEXT NOT NULL,
  content TEXT NOT NULL,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Create integration_accounts table
CREATE TABLE public.integration_accounts (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  provider TEXT NOT NULL,
  account_type TEXT NOT NULL,
  external_account_id TEXT,
  unipile_account_id TEXT,
  account_label TEXT,
  owner_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Create candidate_resumes table
CREATE TABLE public.candidate_resumes (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  candidate_id UUID REFERENCES public.candidates(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  file_name TEXT,
  mime_type TEXT,
  file_size INTEGER,
  raw_text TEXT,
  parsed_json JSONB,
  ai_summary TEXT,
  parse_status TEXT,
  parse_error TEXT,
  source TEXT,
  storage_bucket TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Create webhook_events table
CREATE TABLE public.webhook_events (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  provider TEXT NOT NULL,
  event_type TEXT,
  payload JSONB NOT NULL,
  received_at TIMESTAMPTZ,
  processed BOOLEAN DEFAULT false,
  processed_at TIMESTAMPTZ,
  error TEXT
);

-- Enable RLS
ALTER TABLE public.sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sequence_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.send_outs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sequence_enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sequence_step_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.candidate_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contact_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integration_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.candidate_resumes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_events ENABLE ROW LEVEL SECURITY;

-- Create updated_at triggers
CREATE TRIGGER update_sequences_updated_at
  BEFORE UPDATE ON public.sequences
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_sequence_steps_updated_at
  BEFORE UPDATE ON public.sequence_steps
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_send_outs_updated_at
  BEFORE UPDATE ON public.send_outs
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_sequence_enrollments_updated_at
  BEFORE UPDATE ON public.sequence_enrollments
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_candidate_channels_updated_at
  BEFORE UPDATE ON public.candidate_channels
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_contact_channels_updated_at
  BEFORE UPDATE ON public.contact_channels
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_conversations_updated_at
  BEFORE UPDATE ON public.conversations
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_messages_updated_at
  BEFORE UPDATE ON public.messages
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_notes_updated_at
  BEFORE UPDATE ON public.notes
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_integration_accounts_updated_at
  BEFORE UPDATE ON public.integration_accounts
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_candidate_resumes_updated_at
  BEFORE UPDATE ON public.candidate_resumes
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();