
-- Enum types
CREATE TYPE public.lead_status AS ENUM ('new', 'reached_out', 'qualified', 'converted', 'disqualified', 'no_answer');
CREATE TYPE public.lead_type AS ENUM ('opportunity', 'lead_candidate', 'contact', 'target_company');
CREATE TYPE public.job_stage AS ENUM ('warm', 'hot', 'interviewing', 'offer', 'accepted', 'declined', 'lost', 'on_hold');
CREATE TYPE public.candidate_stage AS ENUM ('back_of_resume', 'pitch', 'send_out', 'submitted', 'interview', 'first_round', 'second_round', 'third_plus_round', 'offer', 'accepted', 'declined', 'counter_offer', 'disqualified');
CREATE TYPE public.company_status AS ENUM ('target', 'client');
CREATE TYPE public.campaign_type AS ENUM ('candidate_outreach', 'account_based', 'opportunity_based', 'check_in');
CREATE TYPE public.campaign_status AS ENUM ('draft', 'active', 'paused', 'completed');
CREATE TYPE public.channel_type AS ENUM ('linkedin_recruiter', 'sales_nav', 'linkedin_message', 'linkedin_connection', 'email', 'sms', 'phone');
CREATE TYPE public.communication_type AS ENUM ('email', 'linkedin', 'sms', 'call', 'note');
CREATE TYPE public.communication_direction AS ENUM ('inbound', 'outbound');
CREATE TYPE public.record_type AS ENUM ('lead', 'candidate', 'contact', 'company', 'job');
CREATE TYPE public.activity_type AS ENUM ('email_sent', 'call_made', 'meeting_scheduled', 'note_added', 'stage_changed', 'linkedin_sent');
CREATE TYPE public.priority_level AS ENUM ('low', 'medium', 'high');

-- Companies table
CREATE TABLE public.companies (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  name TEXT NOT NULL,
  industry TEXT NOT NULL DEFAULT '',
  website TEXT,
  size TEXT,
  status public.company_status NOT NULL DEFAULT 'target',
  primary_contact TEXT,
  primary_contact_id UUID,
  location TEXT NOT NULL DEFAULT '',
  notes TEXT,
  job_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Contacts table
CREATE TABLE public.contacts (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  phone TEXT,
  title TEXT NOT NULL DEFAULT '',
  company_id UUID REFERENCES public.companies(id) ON DELETE SET NULL,
  company_name TEXT NOT NULL DEFAULT '',
  is_client BOOLEAN NOT NULL DEFAULT false,
  linkedin_url TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_contacted_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Leads table
CREATE TABLE public.leads (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  type public.lead_type NOT NULL DEFAULT 'lead_candidate',
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  company TEXT,
  title TEXT,
  status public.lead_status NOT NULL DEFAULT 'new',
  source TEXT,
  tags TEXT[] NOT NULL DEFAULT '{}',
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_contacted_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Jobs table
CREATE TABLE public.jobs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  title TEXT NOT NULL,
  company TEXT NOT NULL DEFAULT '',
  company_id UUID REFERENCES public.companies(id) ON DELETE SET NULL,
  location TEXT NOT NULL DEFAULT '',
  salary TEXT,
  stage public.job_stage NOT NULL DEFAULT 'warm',
  priority public.priority_level NOT NULL DEFAULT 'medium',
  hiring_manager TEXT,
  notes TEXT,
  candidate_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Candidates table
CREATE TABLE public.candidates (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  phone TEXT,
  current_title TEXT NOT NULL DEFAULT '',
  current_company TEXT NOT NULL DEFAULT '',
  linkedin_url TEXT,
  stage public.candidate_stage NOT NULL DEFAULT 'back_of_resume',
  tagged_job_id UUID REFERENCES public.jobs(id) ON DELETE SET NULL,
  tagged_opportunity_id UUID,
  source TEXT,
  skills TEXT[] NOT NULL DEFAULT '{}',
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Campaigns table
CREATE TABLE public.campaigns (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  name TEXT NOT NULL,
  type public.campaign_type NOT NULL DEFAULT 'candidate_outreach',
  status public.campaign_status NOT NULL DEFAULT 'draft',
  enrolled_count INTEGER NOT NULL DEFAULT 0,
  response_rate NUMERIC NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Campaign steps table
CREATE TABLE public.campaign_steps (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  campaign_id UUID REFERENCES public.campaigns(id) ON DELETE CASCADE NOT NULL,
  "order" INTEGER NOT NULL DEFAULT 0,
  channel public.channel_type NOT NULL DEFAULT 'email',
  subject TEXT,
  content TEXT NOT NULL DEFAULT '',
  delay_days INTEGER NOT NULL DEFAULT 0,
  condition TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Communications table
CREATE TABLE public.communications (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  type public.communication_type NOT NULL DEFAULT 'email',
  direction public.communication_direction NOT NULL DEFAULT 'outbound',
  subject TEXT,
  content TEXT NOT NULL DEFAULT '',
  timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
  record_id UUID NOT NULL,
  record_type public.record_type NOT NULL,
  duration INTEGER,
  audio_url TEXT,
  summary TEXT
);

-- Activities table
CREATE TABLE public.activities (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  type public.activity_type NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
  record_id UUID NOT NULL,
  record_type public.record_type NOT NULL
);

-- Enable RLS on all tables
ALTER TABLE public.companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaign_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.communications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activities ENABLE ROW LEVEL SECURITY;

-- RLS policies: users can only access their own data
CREATE POLICY "Users can CRUD own companies" ON public.companies FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can CRUD own contacts" ON public.contacts FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can CRUD own leads" ON public.leads FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can CRUD own jobs" ON public.jobs FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can CRUD own candidates" ON public.candidates FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can CRUD own campaigns" ON public.campaigns FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can CRUD own campaign_steps" ON public.campaign_steps FOR ALL USING (campaign_id IN (SELECT id FROM public.campaigns WHERE user_id = auth.uid())) WITH CHECK (campaign_id IN (SELECT id FROM public.campaigns WHERE user_id = auth.uid()));
CREATE POLICY "Users can CRUD own communications" ON public.communications FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can CRUD own activities" ON public.activities FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- Updated_at trigger function
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

-- Apply updated_at triggers
CREATE TRIGGER update_companies_updated_at BEFORE UPDATE ON public.companies FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER update_contacts_updated_at BEFORE UPDATE ON public.contacts FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER update_leads_updated_at BEFORE UPDATE ON public.leads FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER update_jobs_updated_at BEFORE UPDATE ON public.jobs FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER update_candidates_updated_at BEFORE UPDATE ON public.candidates FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER update_campaigns_updated_at BEFORE UPDATE ON public.campaigns FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Indexes for common queries
CREATE INDEX idx_leads_user_status ON public.leads(user_id, status);
CREATE INDEX idx_jobs_user_stage ON public.jobs(user_id, stage);
CREATE INDEX idx_candidates_user_stage ON public.candidates(user_id, stage);
CREATE INDEX idx_candidates_tagged_job ON public.candidates(tagged_job_id);
CREATE INDEX idx_communications_record ON public.communications(record_id, record_type);
CREATE INDEX idx_activities_record ON public.activities(record_id, record_type);
CREATE INDEX idx_campaign_steps_campaign ON public.campaign_steps(campaign_id);
CREATE INDEX idx_contacts_company ON public.contacts(company_id);
