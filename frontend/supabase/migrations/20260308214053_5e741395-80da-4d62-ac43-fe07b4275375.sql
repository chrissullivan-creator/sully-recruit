-- Grant usage to postgres role for cron scheduling
GRANT USAGE ON SCHEMA cron TO postgres;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA cron TO postgres;

-- Schedule the email processor to run every minute
SELECT cron.schedule(
  'process-sequence-emails',
  '* * * * *',
  $$
  SELECT
    net.http_post(
      url := 'https://xlobevmhzimxjtpiontf.supabase.co/functions/v1/process-sequence-emails',
      headers := '{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inhsb2Jldm1oemlteGp0cGlvbnRmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI0ODc2MTcsImV4cCI6MjA4ODA2MzYxN30.OE6Adrd1_7cqJazAH6lALkhGhoszviodqE6sfWpuiQg"}'::jsonb,
      body := '{}'::jsonb
    ) AS request_id;
  $$
);