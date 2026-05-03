-- Pass 2a: additive scaffolding for unified person model.
-- No data moves, no FK repointing, no contacts drops. Sets schema up so a future
-- pass can merge contacts INTO candidates (UUIDs already verified non-colliding).

-- Person type column (mirrors the existing `roles` array, but a single canonical value)
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS type text NOT NULL DEFAULT 'candidate'
  CHECK (type IN ('candidate', 'client'));
ALTER TABLE contacts   ADD COLUMN IF NOT EXISTS type text NOT NULL DEFAULT 'client'
  CHECK (type IN ('candidate', 'client'));

-- Backfill type from roles when present (roles[1] is the primary role)
UPDATE candidates SET type = 'client'    WHERE 'client'    = ANY(roles) AND type = 'candidate';
UPDATE contacts   SET type = 'candidate' WHERE 'candidate' = ANY(roles) AND type = 'client';

-- Add client-relevant columns to candidates so it can hold client rows after merge.
-- These mirror columns currently only on contacts.
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS company_id uuid REFERENCES companies(id) ON DELETE SET NULL;
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS title      text;
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS department text;

CREATE INDEX IF NOT EXISTS idx_candidates_type       ON candidates(type);
CREATE INDEX IF NOT EXISTS idx_candidates_company_id ON candidates(company_id) WHERE company_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_contacts_type         ON contacts(type);

COMMENT ON COLUMN candidates.type IS 'Unified person type: candidate or client. Drives future merge with contacts.';
COMMENT ON COLUMN contacts.type   IS 'Unified person type: candidate or client. Drives future merge with candidates.';
