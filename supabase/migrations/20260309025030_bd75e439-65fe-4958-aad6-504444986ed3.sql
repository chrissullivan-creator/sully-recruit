
-- Tasks table
CREATE TABLE public.tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'pending',
  priority text NOT NULL DEFAULT 'medium',
  due_date timestamp with time zone,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  assigned_to uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  completed_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Task links (polymorphic linking to any entity)
CREATE TABLE public.task_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE(task_id, entity_type, entity_id)
);

-- Task comments
CREATE TABLE public.task_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  body text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Notifications
CREATE TABLE public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type text NOT NULL DEFAULT 'task_assigned',
  title text NOT NULL,
  body text,
  entity_type text,
  entity_id uuid,
  is_read boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Add communication tracking to prospects
ALTER TABLE public.prospects
  ADD COLUMN IF NOT EXISTS last_reached_out_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS last_responded_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS last_comm_channel text;

-- Add communication tracking to contacts
ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS last_reached_out_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS last_responded_at timestamp with time zone;

-- Triggers for updated_at
CREATE TRIGGER set_tasks_updated_at BEFORE UPDATE ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS policies
ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.task_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.task_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

-- Tasks: authenticated users can read all, manage own
CREATE POLICY "Users read all tasks" ON public.tasks FOR SELECT TO authenticated USING (true);
CREATE POLICY "Users manage own tasks" ON public.tasks FOR ALL TO authenticated USING (created_by = auth.uid() OR assigned_to = auth.uid()) WITH CHECK (created_by = auth.uid());

-- Task links: authenticated full access
CREATE POLICY "Authenticated full access task_links" ON public.task_links FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Task comments: authenticated full access
CREATE POLICY "Authenticated full access task_comments" ON public.task_comments FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Notifications: users see own
CREATE POLICY "Users see own notifications" ON public.notifications FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY "Users manage own notifications" ON public.notifications FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY "System can insert notifications" ON public.notifications FOR INSERT TO authenticated WITH CHECK (true);
