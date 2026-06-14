-- Custom fields layer (Salesforce-style admin-defined fields).
-- Pilot scope: candidates. Companies + jobs reuse the same definitions table
-- and add their own custom_fields JSONB column when rolled out.
--
-- Design: definitions live in custom_field_defs; values live in a single
-- JSONB column on the base table keyed by the def's immutable `key`. No
-- per-field column, no EAV joins. `useCandidate` reads people.* so values
-- ride along with the record for free — no view recreation needed.

-- ── Definitions ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS custom_field_defs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type   text NOT NULL CHECK (entity_type IN ('candidate','client','company','job')),
  key           text NOT NULL,   -- immutable slug, e.g. 'visa_expiry'
  label         text NOT NULL,   -- display label, freely renamable
  field_type    text NOT NULL CHECK (field_type IN
                  ('text','number','date','boolean','select','multiselect','url')),
  options       jsonb NOT NULL DEFAULT '[]'::jsonb,  -- picklist values for (multi)select
  required      boolean NOT NULL DEFAULT false,       -- UI-only hint (not DB-enforced)
  section       text,            -- UI grouping, e.g. 'Compliance'
  display_order int NOT NULL DEFAULT 0,
  is_active     boolean NOT NULL DEFAULT true,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_type, key)
);

ALTER TABLE custom_field_defs ENABLE ROW LEVEL SECURITY;

-- Small team: all authenticated users can read; manage is gated in the UI
-- (Settings → Custom Fields is admin-only) — mirrors job_functions.
CREATE POLICY "Authenticated users can read custom_field_defs"
  ON custom_field_defs FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert custom_field_defs"
  ON custom_field_defs FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update custom_field_defs"
  ON custom_field_defs FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated users can delete custom_field_defs"
  ON custom_field_defs FOR DELETE TO authenticated USING (true);

CREATE INDEX IF NOT EXISTS idx_custom_field_defs_entity
  ON custom_field_defs (entity_type, is_active, display_order);

-- ── Values column (candidates pilot) ───────────────────────────────────
ALTER TABLE people ADD COLUMN IF NOT EXISTS custom_fields jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Containment-query index (e.g. custom_fields @> '{"preferred_desk":["Macro"]}')
CREATE INDEX IF NOT EXISTS idx_people_custom_fields
  ON people USING gin (custom_fields jsonb_path_ops);

-- NOTE: value type validation is intentionally enforced in the UI, NOT via a
-- DB trigger. people has ~13.6k rows and many writers (webhooks, backfills,
-- the sequence engine); a validating BEFORE trigger risks blocking unrelated
-- updates. `required` is likewise a UI hint only.
