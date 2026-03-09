import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

export interface Task {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  due_date: string | null;
  created_by: string | null;
  assigned_to: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  task_links?: TaskLink[];
  task_comments?: TaskComment[];
}

export interface TaskLink {
  id: string;
  task_id: string;
  entity_type: string;
  entity_id: string;
  created_at: string;
}

export interface TaskComment {
  id: string;
  task_id: string;
  user_id: string | null;
  body: string;
  created_at: string;
}

export interface Notification {
  id: string;
  user_id: string;
  type: string;
  title: string;
  body: string | null;
  entity_type: string | null;
  entity_id: string | null;
  is_read: boolean;
  created_at: string;
}

export function useTasks(filter?: { status?: string; assigned_to?: string }) {
  return useQuery({
    queryKey: ['tasks', filter],
    queryFn: async () => {
      let query = supabase
        .from('tasks')
        .select('*, task_links(*), task_comments(*)')
        .order('created_at', { ascending: false });
      if (filter?.status && filter.status !== 'all') {
        query = query.eq('status', filter.status);
      }
      if (filter?.assigned_to) {
        query = query.eq('assigned_to', filter.assigned_to);
      }
      const { data, error } = await query;
      if (error) throw error;
      return (data || []) as Task[];
    },
  });
}

export function useEntityTasks(entityType: string, entityId: string | undefined) {
  return useQuery({
    queryKey: ['entity_tasks', entityType, entityId],
    enabled: !!entityId,
    queryFn: async () => {
      const { data: links, error: linkErr } = await supabase
        .from('task_links')
        .select('task_id')
        .eq('entity_type', entityType)
        .eq('entity_id', entityId!);
      if (linkErr) throw linkErr;
      if (!links?.length) return [] as Task[];

      const taskIds = links.map((l: any) => l.task_id);
      const { data, error } = await supabase
        .from('tasks')
        .select('*, task_links(*), task_comments(*)')
        .in('id', taskIds)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data || []) as Task[];
    },
  });
}

export function useNotifications() {
  return useQuery({
    queryKey: ['notifications'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('notifications')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      return (data || []) as Notification[];
    },
  });
}

export function useCreateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: {
      title: string;
      description?: string;
      priority?: string;
      due_date?: string;
      assigned_to?: string;
      links?: { entity_type: string; entity_id: string }[];
    }) => {
      const userId = (await supabase.auth.getUser()).data.user?.id;
      const { data: task, error } = await supabase
        .from('tasks')
        .insert({
          title: payload.title,
          description: payload.description || null,
          priority: payload.priority || 'medium',
          due_date: payload.due_date || null,
          assigned_to: payload.assigned_to || null,
          created_by: userId,
        } as any)
        .select()
        .single();
      if (error) throw error;

      if (payload.links?.length) {
        const linkRows = payload.links.map((l) => ({
          task_id: task.id,
          entity_type: l.entity_type,
          entity_id: l.entity_id,
        }));
        await supabase.from('task_links').insert(linkRows as any);
      }

      // Notify assigned user
      if (payload.assigned_to && payload.assigned_to !== userId) {
        await supabase.from('notifications').insert({
          user_id: payload.assigned_to,
          type: 'task_assigned',
          title: 'New task assigned to you',
          body: payload.title,
          entity_type: 'task',
          entity_id: task.id,
        } as any);
      }

      return task;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tasks'] });
      qc.invalidateQueries({ queryKey: ['entity_tasks'] });
      toast.success('Task created');
    },
    onError: (err: any) => toast.error(err.message || 'Failed to create task'),
  });
}

export function useUpdateTaskStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ taskId, status }: { taskId: string; status: string }) => {
      const updates: any = { status };
      if (status === 'completed') updates.completed_at = new Date().toISOString();
      const { error } = await supabase.from('tasks').update(updates).eq('id', taskId);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tasks'] });
      qc.invalidateQueries({ queryKey: ['entity_tasks'] });
    },
  });
}

export function useBulkUpdateTasks() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ taskIds, updates }: { taskIds: string[]; updates: Record<string, any> }) => {
      if (updates.status === 'completed') updates.completed_at = new Date().toISOString();
      const { error } = await supabase.from('tasks').update(updates).in('id', taskIds);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tasks'] });
      qc.invalidateQueries({ queryKey: ['entity_tasks'] });
    },
  });
}

export function useBulkDeleteTasks() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (taskIds: string[]) => {
      // Delete links and comments first, then tasks
      await supabase.from('task_comments').delete().in('task_id', taskIds);
      await supabase.from('task_links').delete().in('task_id', taskIds);
      const { error } = await supabase.from('tasks').delete().in('id', taskIds);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tasks'] });
      qc.invalidateQueries({ queryKey: ['entity_tasks'] });
      toast.success('Tasks deleted');
    },
    onError: (err: any) => toast.error(err.message || 'Failed to delete tasks'),
  });
}

export function useAddTaskComment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ taskId, body }: { taskId: string; body: string }) => {
      const userId = (await supabase.auth.getUser()).data.user?.id;
      const { error } = await supabase.from('task_comments').insert({
        task_id: taskId,
        user_id: userId,
        body,
      } as any);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tasks'] });
      qc.invalidateQueries({ queryKey: ['entity_tasks'] });
    },
  });
}
