-- Add external_id to tasks for deduplicating calendar events from Microsoft Graph
ALTER TABLE public.tasks ADD COLUMN IF NOT EXISTS external_id TEXT;
CREATE INDEX IF NOT EXISTS idx_tasks_external_id ON public.tasks (external_id) WHERE external_id IS NOT NULL;
