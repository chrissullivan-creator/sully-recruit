-- Embed the joe_says brief (the rich, recruiter-ready summary) so Ask
-- Joe can do vector retrieval against the brief itself, not just
-- against the underlying resume. 1024 dims = Voyage voyage-finance-2.
-- Indexed for fast ANN search; partial index (only embed when present)
-- to keep the index small.

ALTER TABLE people
  ADD COLUMN IF NOT EXISTS joe_says_embedding vector(1024),
  ADD COLUMN IF NOT EXISTS joe_says_embedded_at timestamptz;

CREATE INDEX IF NOT EXISTS people_joe_says_embedding_ivfflat
  ON people
  USING ivfflat (joe_says_embedding vector_cosine_ops)
  WITH (lists = 50)
  WHERE joe_says_embedding IS NOT NULL;

-- Match RPC mirrors the resume_embeddings shape so the edge function
-- can call either with the same interface. Returns the people row id +
-- similarity score so the caller can enrich from the candidates view.
CREATE OR REPLACE FUNCTION match_people_joe_says(
  query_embedding vector(1024),
  match_count integer DEFAULT 16,
  min_similarity double precision DEFAULT 0.3,
  role_filter text DEFAULT NULL
)
RETURNS TABLE (
  person_id uuid,
  similarity double precision,
  joe_says_excerpt text
)
LANGUAGE sql STABLE
AS $$
  SELECT
    p.id AS person_id,
    1 - (p.joe_says_embedding <=> query_embedding) AS similarity,
    left(p.joe_says, 600) AS joe_says_excerpt
  FROM people p
  WHERE p.joe_says_embedding IS NOT NULL
    AND p.deleted_at IS NULL
    AND (role_filter IS NULL OR role_filter = ANY(p.roles))
    AND 1 - (p.joe_says_embedding <=> query_embedding) >= min_similarity
  ORDER BY p.joe_says_embedding <=> query_embedding
  LIMIT match_count;
$$;

GRANT EXECUTE ON FUNCTION match_people_joe_says(vector, integer, double precision, text) TO authenticated, service_role;
