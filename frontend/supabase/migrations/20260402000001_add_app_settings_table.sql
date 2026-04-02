-- App-level settings/secrets table for org-wide API keys.
-- Per-user credentials stay in user_integrations.
-- This table stores global keys like Anthropic, Voyage, Microsoft Graph app credentials.

CREATE TABLE IF NOT EXISTS app_settings (
  key text PRIMARY KEY,
  value text NOT NULL,
  description text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Only service_role can read/write (these are secrets)
ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role manages app_settings"
  ON app_settings FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Seed with placeholder keys (replace values in Supabase Dashboard → Table Editor)
INSERT INTO app_settings (key, value, description) VALUES
  ('ANTHROPIC_API_KEY', '', 'Anthropic Claude API key for resume parsing, transcription, sentiment'),
  ('VOYAGE_API_KEY', '', 'Voyage AI API key for resume embeddings (voyage-finance-2)'),
  ('MICROSOFT_GRAPH_CLIENT_ID', '', 'Azure app registration client ID (emeraldrecruit.com tenant)'),
  ('MICROSOFT_GRAPH_CLIENT_SECRET', '', 'Azure app registration client secret'),
  ('MICROSOFT_GRAPH_TENANT_ID', '', 'Azure tenant ID for emeraldrecruit.com')
ON CONFLICT (key) DO NOTHING;
