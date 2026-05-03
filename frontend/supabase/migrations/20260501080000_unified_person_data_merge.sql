-- Pass 5a: data merge of contacts INTO candidates with backwards-compat view.
--
-- Strategy:
--   * candidates table now holds both candidates (type='candidate') and clients (type='client')
--   * UUIDs preserved across the merge
--   * Email/unipile_sales_nav_id collisions handled:
--       - Cross-table dupes (contact email = existing candidate email): contact remapped
--         to that candidate's UUID; not inserted
--       - Intra-contact email dupes: keep most recent (rn=1), other rows remapped to winner
--       - unipile_sales_nav_id intra-dupes: nullified on losing rows
--   * 16 FK columns named contact_id (or interviewer_contact_id, linked_contact_id) now
--     reference candidates(id) instead of contacts(id)
--   * contacts table dropped, replaced with VIEW over candidates WHERE type='client'
--   * INSTEAD OF triggers redirect view writes to candidates
--
-- Result counts: 11,331 existing candidates + 1,868 newly-inserted clients = 13,199 total.
-- 48 contacts merged via remap (not inserted as their own row).

-- Step 1: add LinkedIn enrichment columns
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS linkedin_headline        text;
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS linkedin_current_company text;
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS linkedin_current_title   text;
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS linkedin_location        text;
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS linkedin_profile_text    text;
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS linkedin_last_synced_at  timestamptz;
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS ai_search_text           text;
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS company_name             text;

-- Step 2: drop all 16 FK constraints up front
ALTER TABLE ai_call_notes          DROP CONSTRAINT ai_call_notes_contact_id_fkey;
ALTER TABLE ai_runs                DROP CONSTRAINT ai_runs_contact_id_fkey;
ALTER TABLE call_logs              DROP CONSTRAINT call_logs_contact_id_fkey;
ALTER TABLE call_processing_queue  DROP CONSTRAINT call_processing_queue_contact_id_fkey;
ALTER TABLE candidates             DROP CONSTRAINT candidates_linked_contact_id_fkey;
ALTER TABLE contact_embeddings     DROP CONSTRAINT contact_embeddings_contact_id_fkey;
ALTER TABLE conversations          DROP CONSTRAINT conversations_contact_id_fkey;
ALTER TABLE interviews             DROP CONSTRAINT interviews_interviewer_contact_id_fkey;
ALTER TABLE job_contacts           DROP CONSTRAINT job_contacts_contact_id_fkey;
ALTER TABLE jobs                   DROP CONSTRAINT jobs_contact_id_fkey;
ALTER TABLE messages               DROP CONSTRAINT messages_contact_id_fkey;
ALTER TABLE placements             DROP CONSTRAINT placements_contact_id_fkey;
ALTER TABLE reply_sentiment        DROP CONSTRAINT reply_sentiment_contact_id_fkey;
ALTER TABLE search_documents       DROP CONSTRAINT search_documents_contact_id_fkey;
ALTER TABLE send_outs              DROP CONSTRAINT send_outs_contact_id_fkey;
ALTER TABLE sequence_enrollments   DROP CONSTRAINT sequence_enrollments_contact_id_fkey;

-- Step 3: build unified remap (rows that need remapping: cross-dupes + intra-dupe losers)
CREATE TEMP TABLE contact_remap ON COMMIT DROP AS
WITH ranked AS (
  SELECT id, email, lower(trim(email)) AS norm_email,
    ROW_NUMBER() OVER (
      PARTITION BY CASE WHEN email IS NULL OR email = '' THEN id::text ELSE lower(trim(email)) END
      ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
    ) AS rn,
    FIRST_VALUE(id) OVER (
      PARTITION BY CASE WHEN email IS NULL OR email = '' THEN id::text ELSE lower(trim(email)) END
      ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
    ) AS winner_id
  FROM contacts
)
SELECT r.id AS from_id,
       COALESCE(
         (SELECT cand.id FROM candidates cand WHERE cand.normalized_email = r.norm_email AND r.norm_email IS NOT NULL LIMIT 1),
         r.winner_id
       ) AS to_id
FROM ranked r
WHERE r.id <> COALESCE(
         (SELECT cand.id FROM candidates cand WHERE cand.normalized_email = r.norm_email AND r.norm_email IS NOT NULL LIMIT 1),
         r.winner_id
       );

-- Step 4: remap FK refs on the 16 dependent tables
UPDATE ai_call_notes         SET contact_id              = m.to_id FROM contact_remap m WHERE ai_call_notes.contact_id              = m.from_id;
UPDATE ai_runs               SET contact_id              = m.to_id FROM contact_remap m WHERE ai_runs.contact_id                    = m.from_id;
UPDATE call_logs             SET contact_id              = m.to_id FROM contact_remap m WHERE call_logs.contact_id                  = m.from_id;
UPDATE call_processing_queue SET contact_id              = m.to_id FROM contact_remap m WHERE call_processing_queue.contact_id      = m.from_id;
UPDATE candidates            SET linked_contact_id       = m.to_id FROM contact_remap m WHERE candidates.linked_contact_id          = m.from_id;
UPDATE contact_embeddings    SET contact_id              = m.to_id FROM contact_remap m WHERE contact_embeddings.contact_id         = m.from_id;
UPDATE conversations         SET contact_id              = m.to_id FROM contact_remap m WHERE conversations.contact_id              = m.from_id;
UPDATE interviews            SET interviewer_contact_id  = m.to_id FROM contact_remap m WHERE interviews.interviewer_contact_id     = m.from_id;
UPDATE job_contacts          SET contact_id              = m.to_id FROM contact_remap m WHERE job_contacts.contact_id               = m.from_id;
UPDATE jobs                  SET contact_id              = m.to_id FROM contact_remap m WHERE jobs.contact_id                       = m.from_id;
UPDATE messages              SET contact_id              = m.to_id FROM contact_remap m WHERE messages.contact_id                   = m.from_id;
UPDATE placements            SET contact_id              = m.to_id FROM contact_remap m WHERE placements.contact_id                 = m.from_id;
UPDATE reply_sentiment       SET contact_id              = m.to_id FROM contact_remap m WHERE reply_sentiment.contact_id            = m.from_id;
UPDATE search_documents      SET contact_id              = m.to_id FROM contact_remap m WHERE search_documents.contact_id           = m.from_id;
UPDATE send_outs             SET contact_id              = m.to_id FROM contact_remap m WHERE send_outs.contact_id                  = m.from_id;
UPDATE sequence_enrollments  SET contact_id              = m.to_id FROM contact_remap m WHERE sequence_enrollments.contact_id       = m.from_id;

-- Step 5: disable side-effect triggers during bulk insert
ALTER TABLE candidates DISABLE TRIGGER trg_fetch_candidate_history;
ALTER TABLE candidates DISABLE TRIGGER trg_log_candidate_status_change;

-- Step 6: bulk insert non-remapped contacts as candidates with type='client'.
-- Nullify unipile_sales_nav_id on intra-dupes to avoid unique constraint conflicts.
INSERT INTO candidates (
  id, type, first_name, last_name, full_name,
  email, phone, linkedin_url,
  title, department, company_id, company_name,
  status, owner_user_id, created_by_user_id,
  created_at, updated_at,
  last_contacted_at, last_responded_at,
  notes, last_comm_channel, location_text,
  linkedin_headline, linkedin_current_company, linkedin_current_title,
  linkedin_location, linkedin_profile_text, linkedin_last_synced_at, ai_search_text,
  avatar_url, profile_picture_url, linkedin_profile_data,
  unipile_sales_nav_id, unipile_provider_id, unipile_resolve_status,
  linkedin_enriched_at, linkedin_enrichment_source,
  last_sequence_sentiment, last_sequence_sentiment_note,
  unipile_recruiter_id, unipile_classic_id,
  work_email, personal_email, mobile_phone,
  roles, linked_contact_id, is_stub
)
SELECT
  c.id, 'client', c.first_name, c.last_name, c.full_name,
  c.email, c.phone, c.linkedin_url,
  c.title, c.department, c.company_id, c.company_name,
  CASE WHEN c.status IN ('new','reached_out','engaged') THEN c.status ELSE 'new' END,
  COALESCE(c.owner_user_id, c.owner_id, c.user_id),
  c.user_id,
  c.created_at, c.updated_at,
  COALESCE(c.last_contacted_at, c.last_reached_out_at),
  COALESCE(c.last_responded_at, c.last_replied_at),
  c.notes, c.last_comm_channel, c.location,
  c.linkedin_headline, c.linkedin_current_company, c.linkedin_current_title,
  c.linkedin_location, c.linkedin_profile_text, c.linkedin_last_synced_at, c.ai_search_text,
  c.avatar_url, c.profile_picture_url, c.linkedin_profile_data,
  CASE
    WHEN c.unipile_sales_nav_id IS NULL THEN NULL
    WHEN ROW_NUMBER() OVER (PARTITION BY c.unipile_sales_nav_id ORDER BY c.updated_at DESC NULLS LAST, c.created_at DESC NULLS LAST) = 1
    THEN c.unipile_sales_nav_id
    ELSE NULL
  END,
  c.unipile_provider_id, c.unipile_resolve_status,
  c.linkedin_enriched_at, c.linkedin_enrichment_source,
  c.last_sequence_sentiment, c.last_sequence_sentiment_note,
  c.unipile_recruiter_id, c.unipile_classic_id,
  c.work_email, c.personal_email, c.mobile_phone,
  COALESCE(c.roles, ARRAY['client']::text[]),
  c.linked_candidate_id, c.is_stub
FROM contacts c
WHERE c.id NOT IN (SELECT from_id FROM contact_remap);

-- Step 7: re-enable triggers
ALTER TABLE candidates ENABLE TRIGGER trg_fetch_candidate_history;
ALTER TABLE candidates ENABLE TRIGGER trg_log_candidate_status_change;

-- Step 8: drop the old contacts table
DROP TABLE contacts CASCADE;

-- Step 9: re-add 16 FK constraints pointing at candidates(id)
ALTER TABLE ai_call_notes          ADD CONSTRAINT ai_call_notes_contact_id_fkey          FOREIGN KEY (contact_id)             REFERENCES candidates(id) ON DELETE CASCADE;
ALTER TABLE ai_runs                ADD CONSTRAINT ai_runs_contact_id_fkey                FOREIGN KEY (contact_id)             REFERENCES candidates(id) ON DELETE SET NULL;
ALTER TABLE call_logs              ADD CONSTRAINT call_logs_contact_id_fkey              FOREIGN KEY (contact_id)             REFERENCES candidates(id) ON DELETE SET NULL;
ALTER TABLE call_processing_queue  ADD CONSTRAINT call_processing_queue_contact_id_fkey  FOREIGN KEY (contact_id)             REFERENCES candidates(id);
ALTER TABLE candidates             ADD CONSTRAINT candidates_linked_contact_id_fkey      FOREIGN KEY (linked_contact_id)      REFERENCES candidates(id) ON DELETE SET NULL;
ALTER TABLE contact_embeddings     ADD CONSTRAINT contact_embeddings_contact_id_fkey     FOREIGN KEY (contact_id)             REFERENCES candidates(id) ON DELETE CASCADE;
ALTER TABLE conversations          ADD CONSTRAINT conversations_contact_id_fkey          FOREIGN KEY (contact_id)             REFERENCES candidates(id) ON DELETE CASCADE;
ALTER TABLE interviews             ADD CONSTRAINT interviews_interviewer_contact_id_fkey FOREIGN KEY (interviewer_contact_id) REFERENCES candidates(id) ON DELETE SET NULL;
ALTER TABLE job_contacts           ADD CONSTRAINT job_contacts_contact_id_fkey           FOREIGN KEY (contact_id)             REFERENCES candidates(id) ON DELETE CASCADE;
ALTER TABLE jobs                   ADD CONSTRAINT jobs_contact_id_fkey                   FOREIGN KEY (contact_id)             REFERENCES candidates(id) ON DELETE SET NULL;
ALTER TABLE messages               ADD CONSTRAINT messages_contact_id_fkey               FOREIGN KEY (contact_id)             REFERENCES candidates(id) ON DELETE CASCADE;
ALTER TABLE placements             ADD CONSTRAINT placements_contact_id_fkey             FOREIGN KEY (contact_id)             REFERENCES candidates(id) ON DELETE SET NULL;
ALTER TABLE reply_sentiment        ADD CONSTRAINT reply_sentiment_contact_id_fkey        FOREIGN KEY (contact_id)             REFERENCES candidates(id) ON DELETE CASCADE;
ALTER TABLE search_documents       ADD CONSTRAINT search_documents_contact_id_fkey       FOREIGN KEY (contact_id)             REFERENCES candidates(id) ON DELETE CASCADE;
ALTER TABLE send_outs              ADD CONSTRAINT send_outs_contact_id_fkey              FOREIGN KEY (contact_id)             REFERENCES candidates(id) ON DELETE SET NULL;
ALTER TABLE sequence_enrollments   ADD CONSTRAINT sequence_enrollments_contact_id_fkey   FOREIGN KEY (contact_id)             REFERENCES candidates(id) ON DELETE CASCADE;

-- Step 10: backwards-compat view (selecting candidates where type='client')
CREATE VIEW contacts AS
SELECT
  id, company_id, first_name, last_name, full_name,
  email, phone, linkedin_url, title, department,
  status,
  owner_user_id              AS owner_id,
  created_at, updated_at,
  last_contacted_at          AS last_reached_out_at,
  last_responded_at,
  owner_user_id, notes,
  last_contacted_at,
  last_responded_at          AS last_replied_at,
  linkedin_profile_text, linkedin_headline, linkedin_current_company,
  linkedin_current_title, linkedin_location, linkedin_last_synced_at,
  NULL::tsvector             AS linkedin_search,
  ai_search_text,
  unipile_sales_nav_id, unipile_provider_id, avatar_url, profile_picture_url,
  linkedin_profile_data, unipile_resolve_status, company_name,
  created_by_user_id         AS user_id,
  last_comm_channel,
  linkedin_enriched_at, linkedin_enrichment_source,
  last_sequence_sentiment, last_sequence_sentiment_note,
  unipile_recruiter_id, unipile_classic_id,
  location_text              AS location,
  work_email, personal_email, mobile_phone,
  roles,
  linked_contact_id          AS linked_candidate_id,
  is_stub
FROM candidates
WHERE type = 'client';

COMMENT ON VIEW contacts IS 'Backwards-compat view over candidates WHERE type=client. INSTEAD OF triggers handle writes. Migrate code to query candidates directly with type filter.';

-- Step 11: INSTEAD OF triggers redirecting view writes to candidates
CREATE OR REPLACE FUNCTION contacts_view_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, extensions AS $$
BEGIN
  INSERT INTO candidates (
    id, type, company_id, first_name, last_name, full_name,
    email, phone, linkedin_url, title, department,
    status, owner_user_id, created_at, updated_at,
    last_contacted_at, last_responded_at, notes, last_comm_channel,
    location_text, linkedin_headline, linkedin_current_company, linkedin_current_title,
    linkedin_location, linkedin_profile_text, linkedin_last_synced_at, ai_search_text,
    unipile_sales_nav_id, unipile_provider_id, avatar_url, profile_picture_url,
    linkedin_profile_data, unipile_resolve_status, company_name,
    created_by_user_id, linkedin_enriched_at, linkedin_enrichment_source,
    last_sequence_sentiment, last_sequence_sentiment_note,
    unipile_recruiter_id, unipile_classic_id,
    work_email, personal_email, mobile_phone, roles, linked_contact_id, is_stub
  ) VALUES (
    COALESCE(NEW.id, gen_random_uuid()), 'client', NEW.company_id,
    NEW.first_name, NEW.last_name, NEW.full_name,
    NEW.email, NEW.phone, NEW.linkedin_url, NEW.title, NEW.department,
    CASE WHEN NEW.status IN ('new','reached_out','engaged') THEN NEW.status ELSE 'new' END,
    COALESCE(NEW.owner_user_id, NEW.owner_id),
    COALESCE(NEW.created_at, now()), COALESCE(NEW.updated_at, now()),
    COALESCE(NEW.last_contacted_at, NEW.last_reached_out_at),
    COALESCE(NEW.last_responded_at, NEW.last_replied_at),
    NEW.notes, NEW.last_comm_channel, NEW.location,
    NEW.linkedin_headline, NEW.linkedin_current_company, NEW.linkedin_current_title,
    NEW.linkedin_location, NEW.linkedin_profile_text, NEW.linkedin_last_synced_at, NEW.ai_search_text,
    NEW.unipile_sales_nav_id, NEW.unipile_provider_id, NEW.avatar_url, NEW.profile_picture_url,
    NEW.linkedin_profile_data, NEW.unipile_resolve_status, NEW.company_name,
    NEW.user_id, NEW.linkedin_enriched_at, NEW.linkedin_enrichment_source,
    NEW.last_sequence_sentiment, NEW.last_sequence_sentiment_note,
    NEW.unipile_recruiter_id, NEW.unipile_classic_id,
    NEW.work_email, NEW.personal_email, NEW.mobile_phone,
    COALESCE(NEW.roles, ARRAY['client']::text[]),
    NEW.linked_candidate_id, COALESCE(NEW.is_stub, false)
  );
  RETURN NEW;
END;
$$;
CREATE TRIGGER contacts_view_insert_trg INSTEAD OF INSERT ON contacts FOR EACH ROW EXECUTE FUNCTION contacts_view_insert();

CREATE OR REPLACE FUNCTION contacts_view_update() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, extensions AS $$
BEGIN
  UPDATE candidates SET
    company_id = NEW.company_id, first_name = NEW.first_name, last_name = NEW.last_name,
    full_name = NEW.full_name, email = NEW.email, phone = NEW.phone, linkedin_url = NEW.linkedin_url,
    title = NEW.title, department = NEW.department,
    status = CASE WHEN NEW.status IN ('new','reached_out','engaged') THEN NEW.status ELSE 'new' END,
    owner_user_id = COALESCE(NEW.owner_user_id, NEW.owner_id),
    updated_at = COALESCE(NEW.updated_at, now()),
    last_contacted_at = COALESCE(NEW.last_contacted_at, NEW.last_reached_out_at),
    last_responded_at = COALESCE(NEW.last_responded_at, NEW.last_replied_at),
    notes = NEW.notes, last_comm_channel = NEW.last_comm_channel, location_text = NEW.location,
    linkedin_headline = NEW.linkedin_headline, linkedin_current_company = NEW.linkedin_current_company,
    linkedin_current_title = NEW.linkedin_current_title, linkedin_location = NEW.linkedin_location,
    linkedin_profile_text = NEW.linkedin_profile_text, linkedin_last_synced_at = NEW.linkedin_last_synced_at,
    ai_search_text = NEW.ai_search_text,
    unipile_sales_nav_id = NEW.unipile_sales_nav_id, unipile_provider_id = NEW.unipile_provider_id,
    avatar_url = NEW.avatar_url, profile_picture_url = NEW.profile_picture_url,
    linkedin_profile_data = NEW.linkedin_profile_data, unipile_resolve_status = NEW.unipile_resolve_status,
    company_name = NEW.company_name, created_by_user_id = NEW.user_id,
    linkedin_enriched_at = NEW.linkedin_enriched_at, linkedin_enrichment_source = NEW.linkedin_enrichment_source,
    last_sequence_sentiment = NEW.last_sequence_sentiment, last_sequence_sentiment_note = NEW.last_sequence_sentiment_note,
    unipile_recruiter_id = NEW.unipile_recruiter_id, unipile_classic_id = NEW.unipile_classic_id,
    work_email = NEW.work_email, personal_email = NEW.personal_email, mobile_phone = NEW.mobile_phone,
    roles = NEW.roles, linked_contact_id = NEW.linked_candidate_id, is_stub = NEW.is_stub
  WHERE id = OLD.id AND type = 'client';
  RETURN NEW;
END;
$$;
CREATE TRIGGER contacts_view_update_trg INSTEAD OF UPDATE ON contacts FOR EACH ROW EXECUTE FUNCTION contacts_view_update();

CREATE OR REPLACE FUNCTION contacts_view_delete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, extensions AS $$
BEGIN
  DELETE FROM candidates WHERE id = OLD.id AND type = 'client';
  RETURN OLD;
END;
$$;
CREATE TRIGGER contacts_view_delete_trg INSTEAD OF DELETE ON contacts FOR EACH ROW EXECUTE FUNCTION contacts_view_delete();
