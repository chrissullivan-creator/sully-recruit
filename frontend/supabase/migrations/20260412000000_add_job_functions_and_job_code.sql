-- Job Functions lookup table
CREATE TABLE IF NOT EXISTS job_functions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  code text NOT NULL UNIQUE,
  examples text[] NOT NULL DEFAULT '{}',
  sort_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE job_functions ENABLE ROW LEVEL SECURITY;

-- All authenticated users can read
CREATE POLICY "Authenticated users can read job_functions"
  ON job_functions FOR SELECT
  TO authenticated
  USING (true);

-- All authenticated users can manage (small team, no need for admin-only)
CREATE POLICY "Authenticated users can insert job_functions"
  ON job_functions FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated users can update job_functions"
  ON job_functions FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Authenticated users can delete job_functions"
  ON job_functions FOR DELETE
  TO authenticated
  USING (true);

-- Seed default functions with examples
INSERT INTO job_functions (name, code, examples, sort_order) VALUES
  ('Trading Desk',  'TD',   ARRAY['Portfolio Managers', 'Quantitative Researchers', 'Data Scientists', 'Sales and Trading'], 1),
  ('Technology',    'TECH', ARRAY[]::text[], 2),
  ('Operations',    'OPS',  ARRAY[]::text[], 3),
  ('Client',        'CLI',  ARRAY['Sales', 'Client Service', 'Relationship Management'], 4),
  ('Finance',       'FIN',  ARRAY['Fund Accounting', 'Controller', 'Product Control', 'Regulatory Reporting'], 5),
  ('Compliance',    'COMP', ARRAY[]::text[], 6),
  ('Risk',          'RISK', ARRAY['Operational', 'Market', 'Credit'], 7)
ON CONFLICT (name) DO NOTHING;

-- Add columns to jobs table
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS job_function_id uuid REFERENCES job_functions(id) ON DELETE SET NULL;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS job_code text;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS num_openings int NOT NULL DEFAULT 1;

-- Unique constraint on job_code (allows null)
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_job_code ON jobs (job_code) WHERE job_code IS NOT NULL;

-- Helper function: generate next job code for a given function
CREATE OR REPLACE FUNCTION generate_job_code(p_function_id uuid)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_code text;
  v_next int;
BEGIN
  -- Get the function code
  SELECT code INTO v_code FROM job_functions WHERE id = p_function_id;
  IF v_code IS NULL THEN
    RETURN NULL;
  END IF;

  -- Count existing jobs with this function to find next number
  SELECT COALESCE(MAX(
    CAST(NULLIF(regexp_replace(job_code, '^[A-Z]+-', ''), '') AS int)
  ), 0) + 1
  INTO v_next
  FROM jobs
  WHERE job_function_id = p_function_id
    AND job_code IS NOT NULL;

  RETURN v_code || '-' || LPAD(v_next::text, 3, '0');
END;
$$;
