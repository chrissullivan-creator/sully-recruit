-- Seed UNIPILE_BASE_URL into app_settings for Trigger.dev tasks.
-- This is the per-account DSN assigned by Unipile.
INSERT INTO app_settings (key, value, description) VALUES
  ('UNIPILE_BASE_URL', 'https://api19.unipile.com:14926/api/v1', 'Unipile API base URL (per-account DSN)')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
