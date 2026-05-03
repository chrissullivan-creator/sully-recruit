-- Pass 3a: drop 5 confirmed-redundant indexes (verified identical definitions exist elsewhere)
DROP INDEX IF EXISTS public.idx_ai_notes_phone;                  -- dup of idx_ai_call_notes_phone_number
DROP INDEX IF EXISTS public.idx_ai_call_notes_external_call_id;  -- dup of ai_call_notes_external_call_id_key (UNIQUE)
ALTER TABLE candidate_jobs DROP CONSTRAINT IF EXISTS candidate_jobs_candidate_job_unique; -- dup of candidate_jobs_candidate_id_job_id_key constraint
DROP INDEX IF EXISTS public.idx_candidates_unipile_sales_nav_id; -- dup of candidates_unipile_id_idx (UNIQUE)
DROP INDEX IF EXISTS public.idx_daily_send_log_lookup;           -- dup of daily_send_log_account_id_channel_send_date_key (UNIQUE)
