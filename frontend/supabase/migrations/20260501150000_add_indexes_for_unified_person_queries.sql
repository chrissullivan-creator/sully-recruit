-- Pass 10: indexes to support common queries against the unified candidates table.
-- After Pass 5a, queries like "all clients" or "engaged candidates by owner" hit
-- the unified table and benefit from type-aware indexes.

-- Filter by type alone (e.g. clients view, candidates list)
CREATE INDEX IF NOT EXISTS idx_candidates_type_owner
  ON candidates(type, owner_user_id) WHERE owner_user_id IS NOT NULL;

-- Filter by type + status (e.g. "engaged candidates", "new clients")
CREATE INDEX IF NOT EXISTS idx_candidates_type_status
  ON candidates(type, status);

-- Common sort: most recently updated within a type
CREATE INDEX IF NOT EXISTS idx_candidates_type_updated_at
  ON candidates(type, updated_at DESC);

-- Companies join (clients commonly looked up by their company)
CREATE INDEX IF NOT EXISTS idx_candidates_type_company
  ON candidates(type, company_id) WHERE company_id IS NOT NULL;
