ALTER TABLE public.sequence_nodes
ADD COLUMN IF NOT EXISTS branch_id TEXT NOT NULL DEFAULT 'branch_a';

ALTER TABLE public.sequence_nodes
ADD COLUMN IF NOT EXISTS branch_step_order INTEGER;

UPDATE public.sequence_nodes
SET branch_step_order = COALESCE(branch_step_order, node_order)
WHERE branch_step_order IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'sequence_nodes_branch_id_check'
  ) THEN
    ALTER TABLE public.sequence_nodes
    ADD CONSTRAINT sequence_nodes_branch_id_check
    CHECK (branch_id IN ('branch_a', 'branch_b'));
  END IF;
END $$;
