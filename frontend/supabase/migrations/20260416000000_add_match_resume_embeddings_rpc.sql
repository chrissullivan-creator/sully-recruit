-- Vector similarity RPC for the resume_embeddings table.
-- Uses Voyage voyage-finance-2 (1024-dim) embeddings stored in
-- resume_embeddings.embedding (pgvector). Mirrors match_resume_chunks but
-- searches the canonical full_profile embeddings written by resume-ingestion.

CREATE OR REPLACE FUNCTION match_resume_embeddings(
  query_embedding vector(1024),
  match_count int DEFAULT 20,
  min_similarity float DEFAULT 0.3
)
RETURNS TABLE (
  candidate_id uuid,
  resume_id uuid,
  chunk_text text,
  source_text text,
  similarity float
)
LANGUAGE sql STABLE
AS $$
  SELECT
    re.candidate_id,
    re.resume_id,
    re.chunk_text,
    re.source_text,
    1 - (re.embedding <=> query_embedding) AS similarity
  FROM resume_embeddings re
  WHERE re.embedding IS NOT NULL
    AND 1 - (re.embedding <=> query_embedding) > min_similarity
  ORDER BY re.embedding <=> query_embedding
  LIMIT match_count;
$$;
