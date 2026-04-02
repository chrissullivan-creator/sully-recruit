-- Duplicate candidate clusters for manual review
CREATE TABLE IF NOT EXISTS duplicate_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id_a uuid NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  candidate_id_b uuid NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  match_type text NOT NULL, -- 'email', 'phone', 'linkedin', 'name_company'
  match_value text, -- the matching value
  confidence numeric DEFAULT 1.0, -- 1.0 = exact, 0.x = fuzzy
  status text NOT NULL DEFAULT 'pending', -- 'pending', 'merged', 'dismissed'
  survivor_id uuid REFERENCES candidates(id) ON DELETE SET NULL,
  merged_at timestamptz,
  merged_by uuid REFERENCES auth.users(id),
  created_at timestamptz DEFAULT now(),
  UNIQUE(candidate_id_a, candidate_id_b)
);

ALTER TABLE duplicate_candidates ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users can read duplicates" ON duplicate_candidates FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can manage duplicates" ON duplicate_candidates FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Service role manages duplicates" ON duplicate_candidates FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Merge history log
CREATE TABLE IF NOT EXISTS candidate_merge_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  survivor_id uuid NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  merged_id uuid NOT NULL, -- don't FK since candidate is deleted
  merged_data jsonb NOT NULL, -- snapshot of merged candidate before deletion
  tables_updated jsonb, -- which related tables were updated
  merged_by uuid REFERENCES auth.users(id),
  created_at timestamptz DEFAULT now()
);

ALTER TABLE candidate_merge_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users can read merge log" ON candidate_merge_log FOR SELECT TO authenticated USING (true);
CREATE POLICY "Service role manages merge log" ON candidate_merge_log FOR ALL TO service_role USING (true) WITH CHECK (true);
