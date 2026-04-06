-- Seed Unipile settings into app_settings for Trigger.dev tasks.
INSERT INTO app_settings (key, value, description) VALUES
  ('UNIPILE_BASE_URL', 'https://api19.unipile.com:14926/api/v1', 'Unipile API base URL (per-account DSN)'),
  ('UNIPILE_API_KEY', 'vqxVUUYs.gJux2OaPKhqMhCsB2PdPqa3QbFn4Rp+uXb8zgQWhTRw=', 'Unipile API key for LinkedIn integration')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
