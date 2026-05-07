-- Unipile v2: InMail credit tracking + inbound LinkedIn invitations.
--
-- Why both in one migration: they're the next two Unipile features
-- recruiters asked for. Credits keeps spend visible; inbound invitations
-- surface warm leads that hit the recruiter's profile.

-- 1. Per-account InMail credit balance (refreshed hourly by the
--    sync-inmail-credits Trigger.dev task). Nullable because non-
--    recruiter accounts don't have credits.
ALTER TABLE public.integration_accounts
  ADD COLUMN IF NOT EXISTS inmail_credits_remaining INTEGER,
  ADD COLUMN IF NOT EXISTS inmail_credits_total INTEGER,
  ADD COLUMN IF NOT EXISTS inmail_credits_updated_at TIMESTAMPTZ;

-- 2. Inbound LinkedIn invitations (someone trying to connect with
--    one of our recruiter accounts). The pull-task drops every
--    invitation here; the matched candidate (if any) is then linked
--    so the inbox can show a "wants to connect" badge.
CREATE TABLE IF NOT EXISTS public.linkedin_invitations (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,

  -- Which of our accounts received the invite
  integration_account_id UUID REFERENCES public.integration_accounts(id) ON DELETE CASCADE,
  unipile_account_id TEXT NOT NULL,

  -- The inviter (LinkedIn provider_id is the stable handle here)
  invitation_id TEXT NOT NULL UNIQUE,
  inviter_provider_id TEXT,
  inviter_public_id TEXT,
  inviter_name TEXT,
  inviter_headline TEXT,
  inviter_avatar_url TEXT,

  -- Optional message attached to the invite
  message TEXT,

  -- Resolution: link to a candidate (created or matched). NULL until
  -- the sync task can match by provider_id / linkedin_url.
  candidate_id UUID REFERENCES public.people(id) ON DELETE SET NULL,
  matched_at TIMESTAMPTZ,

  -- Lifecycle
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'declined', 'ignored')),
  invited_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_linkedin_invitations_status
  ON public.linkedin_invitations(status, invited_at DESC);

CREATE INDEX IF NOT EXISTS idx_linkedin_invitations_candidate
  ON public.linkedin_invitations(candidate_id)
  WHERE candidate_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_linkedin_invitations_account
  ON public.linkedin_invitations(integration_account_id, invited_at DESC);

ALTER TABLE public.linkedin_invitations ENABLE ROW LEVEL SECURITY;

-- Recruiters see invitations on accounts they own. Service role
-- (Trigger.dev) writes; everyone read-only via the inbox.
DROP POLICY IF EXISTS "Owners can view their invitations" ON public.linkedin_invitations;
CREATE POLICY "Owners can view their invitations" ON public.linkedin_invitations
  FOR SELECT
  USING (
    integration_account_id IN (
      SELECT id FROM public.integration_accounts WHERE owner_user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Service role manages invitations" ON public.linkedin_invitations;
CREATE POLICY "Service role manages invitations" ON public.linkedin_invitations
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
