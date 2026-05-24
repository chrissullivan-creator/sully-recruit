-- Per-provider credit-balance tracking for the enrichment cascade.
-- Read + written by the check-enrichment-credits Inngest cron (every
-- 6h). One row per provider. `threshold` defaults to 5 — the cron
-- sends an alert email to CREDIT_ALERT_RECIPIENTS the moment any
-- provider drops to or below this. Anti-spam: 24h cooldown unless
-- the balance dropped further since the last alert.

CREATE TABLE IF NOT EXISTS public.provider_credit_state (
  provider text PRIMARY KEY,
  last_balance numeric,
  last_balance_unit text,
  last_checked_at timestamptz,
  last_alert_sent_at timestamptz,
  last_alert_balance numeric,
  threshold numeric NOT NULL DEFAULT 5,
  enabled boolean NOT NULL DEFAULT true,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_provider_credit_state_updated_at ON public.provider_credit_state;
CREATE TRIGGER trg_provider_credit_state_updated_at
  BEFORE UPDATE ON public.provider_credit_state
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Read-only for the app; the cron writes via the service role.
ALTER TABLE public.provider_credit_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "auth read provider_credit_state" ON public.provider_credit_state;
CREATE POLICY "auth read provider_credit_state"
  ON public.provider_credit_state FOR SELECT
  TO authenticated USING (true);

-- Seed rows so the cron has a place to record state from the first
-- run. Operator can flip `enabled = false` or adjust `threshold` per
-- provider via direct UPDATE.
INSERT INTO public.provider_credit_state (provider, threshold) VALUES
  ('apollo',         5),
  ('bettercontact',  5),
  ('fullenrich',     5),
  ('pdl',            5),
  ('zerobounce',     5)
ON CONFLICT (provider) DO NOTHING;

-- Comma-separated list of email addresses. Reuses ALERT_SENDER as the
-- from-address (same mailbox as error alerts in alerting.ts).
INSERT INTO public.app_settings (key, value) VALUES
  ('CREDIT_ALERT_RECIPIENTS', 'chris.sullivan@emeraldrecruit.com')
ON CONFLICT (key) DO NOTHING;
