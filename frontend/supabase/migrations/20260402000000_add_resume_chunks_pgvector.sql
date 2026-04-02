-- Enable pgvector extension for semantic search
CREATE EXTENSION IF NOT EXISTS vector;

-- Resume chunks table for storing embedded text segments
CREATE TABLE IF NOT EXISTS resume_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resume_id uuid NOT NULL REFERENCES resumes(id) ON DELETE CASCADE,
  candidate_id uuid NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  chunk_index int NOT NULL,
  content text NOT NULL,
  embedding vector(1024), -- voyage-finance-2 produces 1024-dim vectors
  created_at timestamptz DEFAULT now()
);

-- Index for fast vector similarity search
CREATE INDEX IF NOT EXISTS idx_resume_chunks_embedding
  ON resume_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- Index for lookups by resume and candidate
CREATE INDEX IF NOT EXISTS idx_resume_chunks_resume_id ON resume_chunks(resume_id);
CREATE INDEX IF NOT EXISTS idx_resume_chunks_candidate_id ON resume_chunks(candidate_id);

-- RPC function for semantic resume search
CREATE OR REPLACE FUNCTION match_resume_chunks(
  query_embedding vector(1024),
  match_count int DEFAULT 10,
  min_similarity float DEFAULT 0.5
)
RETURNS TABLE (
  id uuid,
  resume_id uuid,
  candidate_id uuid,
  content text,
  similarity float
)
LANGUAGE sql STABLE
AS $$
  SELECT
    rc.id,
    rc.resume_id,
    rc.candidate_id,
    rc.content,
    1 - (rc.embedding <=> query_embedding) AS similarity
  FROM resume_chunks rc
  WHERE 1 - (rc.embedding <=> query_embedding) > min_similarity
  ORDER BY rc.embedding <=> query_embedding
  LIMIT match_count;
$$;

-- RLS: allow authenticated users to read resume chunks
ALTER TABLE resume_chunks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read resume chunks"
  ON resume_chunks FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Service role can manage resume chunks"
  ON resume_chunks FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
