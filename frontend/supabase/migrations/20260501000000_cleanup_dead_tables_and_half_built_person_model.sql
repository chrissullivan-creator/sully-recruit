-- Cleanup pass 1: drop dead tables, dead questionnaire system, and the half-built parallel "people" model.
-- Keeps: sequences, placements, search_documents, graph_subscriptions, oauth_states, user_oauth_tokens.

-- Drop dependent views first
DROP VIEW IF EXISTS v_candidate_import_duplicate_review CASCADE;
DROP VIEW IF EXISTS v_candidate_import_duplicate_summary CASCADE;

-- Drop FK columns pointing at people (data is sparse and not used in app code)
ALTER TABLE messages              DROP COLUMN IF EXISTS person_id;
ALTER TABLE conversations         DROP COLUMN IF EXISTS person_id;
ALTER TABLE send_outs             DROP COLUMN IF EXISTS candidate_person_id;
ALTER TABLE send_outs             DROP COLUMN IF EXISTS contact_person_id;
ALTER TABLE sequence_enrollments  DROP COLUMN IF EXISTS person_id;

-- Dead questionnaire system
DROP TABLE IF EXISTS candidate_job_questionnaire_answers CASCADE;
DROP TABLE IF EXISTS candidate_job_questionnaires       CASCADE;
DROP TABLE IF EXISTS job_questionnaire_questions        CASCADE;
DROP TABLE IF EXISTS job_questionnaire_configs          CASCADE;

-- Dead misc
DROP TABLE IF EXISTS morning_briefings         CASCADE;
DROP TABLE IF EXISTS task_collaborators        CASCADE;
DROP TABLE IF EXISTS candidates_import_staging CASCADE;
DROP TABLE IF EXISTS sequence_templates        CASCADE;
DROP TABLE IF EXISTS ai_run_sources            CASCADE;
DROP TABLE IF EXISTS ai_run_events             CASCADE;

-- Half-built parallel person model
DROP TABLE IF EXISTS person_import_issues CASCADE;
DROP TABLE IF EXISTS legacy_person_links  CASCADE;
DROP TABLE IF EXISTS person_channels      CASCADE;
DROP TABLE IF EXISTS person_phones        CASCADE;
DROP TABLE IF EXISTS person_emails        CASCADE;
DROP TABLE IF EXISTS candidate_profiles   CASCADE;
DROP TABLE IF EXISTS contact_profiles     CASCADE;
DROP TABLE IF EXISTS people               CASCADE;
