import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { createQueryWrapper } from '@/test/helpers';

// ─── Mock Supabase ────────────────────────────────────────────────────────────

function createChain(data: any = [], error: any = null) {
  const result = { data, error };
  const chain: any = {
    select: vi.fn().mockReturnValue(null),
    order: vi.fn().mockReturnValue(null),
    eq: vi.fn().mockReturnValue(null),
    in: vi.fn().mockReturnValue(null),
    insert: vi.fn().mockReturnValue(null),
    update: vi.fn().mockReturnValue(null),
    delete: vi.fn().mockReturnValue(null),
    single: vi.fn().mockResolvedValue(result),
    maybeSingle: vi.fn().mockResolvedValue(result),
  };
  // All query-builder methods return the chain
  for (const method of ['select', 'order', 'eq', 'in', 'insert', 'update', 'delete']) {
    chain[method].mockReturnValue(chain);
  }
  // Make thenable
  const promise = Promise.resolve(result);
  chain.then = promise.then.bind(promise);
  chain.catch = promise.catch.bind(promise);
  return chain;
}

const mockFrom = vi.fn();
const mockGetUser = vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } });

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (...args: any[]) => mockFrom(...args),
    auth: { getUser: () => mockGetUser() },
  },
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  useTasks,
  useEntityTasks,
  useCreateTask,
  useUpdateTaskStatus,
  useCompleteTaskWithNote,
  useBulkDeleteTasks,
  useAddTaskComment,
} from './useTasks';

import { toast } from 'sonner';

describe('useTasks hooks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } } });
  });

  describe('useTasks', () => {
    it('fetches tasks and resolves profile names', async () => {
      const tasksData = [
        { id: 't1', title: 'Task 1', created_by: 'user-1', assigned_to: 'user-2', task_links: [], task_comments: [] },
      ];
      const profilesData = [
        { id: 'user-1', full_name: 'Alice', email: 'alice@test.com' },
        { id: 'user-2', full_name: 'Bob', email: 'bob@test.com' },
      ];

      let callCount = 0;
      mockFrom.mockImplementation((table: string) => {
        if (table === 'tasks') return createChain(tasksData);
        if (table === 'profiles') return createChain(profilesData);
        return createChain();
      });

      const { result } = renderHook(() => useTasks(), {
        wrapper: createQueryWrapper(),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(result.current.data).toHaveLength(1);
      expect(result.current.data![0].creator_name).toBe('Alice');
      expect(result.current.data![0].assignee_name).toBe('Bob');
    });

    it('applies status filter', async () => {
      const chain = createChain([]);
      mockFrom.mockReturnValue(chain);

      renderHook(() => useTasks({ status: 'completed' }), {
        wrapper: createQueryWrapper(),
      });

      await waitFor(() => {
        expect(chain.eq).toHaveBeenCalledWith('status', 'completed');
      });
    });

    it('does not filter when status is "all"', async () => {
      const chain = createChain([]);
      mockFrom.mockReturnValue(chain);

      renderHook(() => useTasks({ status: 'all' }), {
        wrapper: createQueryWrapper(),
      });

      // eq should only be called for other filters, not status
      await waitFor(() => {
        const eqCalls = chain.eq.mock.calls;
        const statusCalls = eqCalls.filter((c: any[]) => c[0] === 'status');
        expect(statusCalls).toHaveLength(0);
      });
    });
  });

  describe('useEntityTasks', () => {
    it('does not fetch when entityId is undefined', async () => {
      const { result } = renderHook(() => useEntityTasks('candidate', undefined), {
        wrapper: createQueryWrapper(),
      });

      await waitFor(() => expect(result.current.fetchStatus).toBe('idle'));
      expect(mockFrom).not.toHaveBeenCalled();
    });

    it('returns empty array when no links exist', async () => {
      mockFrom.mockImplementation((table: string) => {
        if (table === 'task_links') return createChain([]);
        return createChain();
      });

      const { result } = renderHook(() => useEntityTasks('candidate', 'c1'), {
        wrapper: createQueryWrapper(),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data).toEqual([]);
    });
  });

  describe('useCreateTask', () => {
    it('creates a task and shows success toast', async () => {
      const createdTask = { id: 'new-task', title: 'Test Task' };
      const insertChain = createChain(createdTask);
      mockFrom.mockReturnValue(insertChain);

      const { result } = renderHook(() => useCreateTask(), {
        wrapper: createQueryWrapper(),
      });

      await act(async () => {
        await result.current.mutateAsync({
          title: 'Test Task',
          description: 'A test task',
        });
      });

      expect(mockFrom).toHaveBeenCalledWith('tasks');
      expect(toast.success).toHaveBeenCalledWith('Task created');
    });

    it('creates task links when provided', async () => {
      const createdTask = { id: 'new-task', title: 'Test Task' };
      const insertChain = createChain(createdTask);
      mockFrom.mockReturnValue(insertChain);

      const { result } = renderHook(() => useCreateTask(), {
        wrapper: createQueryWrapper(),
      });

      await act(async () => {
        await result.current.mutateAsync({
          title: 'Linked Task',
          links: [{ entity_type: 'candidate', entity_id: 'c1' }],
        });
      });

      // Should have called from('task_links') for link creation
      expect(mockFrom).toHaveBeenCalledWith('task_links');
    });

    it('creates notification when assigned to a different user', async () => {
      const createdTask = { id: 'new-task', title: 'Assigned Task' };
      const insertChain = createChain(createdTask);
      mockFrom.mockReturnValue(insertChain);

      const { result } = renderHook(() => useCreateTask(), {
        wrapper: createQueryWrapper(),
      });

      await act(async () => {
        await result.current.mutateAsync({
          title: 'Assigned Task',
          assigned_to: 'user-2',
        });
      });

      expect(mockFrom).toHaveBeenCalledWith('notifications');
    });

    it('shows error toast on failure', async () => {
      const failChain = createChain(null, { message: 'Insert failed' });
      mockFrom.mockReturnValue(failChain);

      const { result } = renderHook(() => useCreateTask(), {
        wrapper: createQueryWrapper(),
      });

      await act(async () => {
        try {
          await result.current.mutateAsync({ title: 'Fail Task' });
        } catch {
          // expected
        }
      });

      expect(toast.error).toHaveBeenCalled();
    });
  });

  describe('useUpdateTaskStatus', () => {
    it('sets completed_at when status is "completed"', async () => {
      const chain = createChain(null, null);
      mockFrom.mockReturnValue(chain);

      const { result } = renderHook(() => useUpdateTaskStatus(), {
        wrapper: createQueryWrapper(),
      });

      await act(async () => {
        await result.current.mutateAsync({ taskId: 't1', status: 'completed' });
      });

      const updateCall = chain.update.mock.calls[0][0];
      expect(updateCall.status).toBe('completed');
      expect(updateCall.completed_at).toBeDefined();
    });

    it('does not set completed_at for non-completed status', async () => {
      const chain = createChain(null, null);
      mockFrom.mockReturnValue(chain);

      const { result } = renderHook(() => useUpdateTaskStatus(), {
        wrapper: createQueryWrapper(),
      });

      await act(async () => {
        await result.current.mutateAsync({ taskId: 't1', status: 'in_progress' });
      });

      const updateCall = chain.update.mock.calls[0][0];
      expect(updateCall.status).toBe('in_progress');
      expect(updateCall.completed_at).toBeUndefined();
    });
  });

  describe('useBulkDeleteTasks', () => {
    it('deletes comments, links, and tasks in order', async () => {
      const chain = createChain(null, null);
      mockFrom.mockReturnValue(chain);

      const { result } = renderHook(() => useBulkDeleteTasks(), {
        wrapper: createQueryWrapper(),
      });

      await act(async () => {
        await result.current.mutateAsync(['t1', 't2']);
      });

      const fromCalls = mockFrom.mock.calls.map((c: any[]) => c[0]);
      expect(fromCalls).toContain('task_comments');
      expect(fromCalls).toContain('task_links');
      expect(fromCalls).toContain('tasks');
      expect(toast.success).toHaveBeenCalledWith('Tasks deleted');
    });
  });

  describe('useAddTaskComment', () => {
    it('inserts a comment with user id', async () => {
      const chain = createChain(null, null);
      mockFrom.mockReturnValue(chain);

      const { result } = renderHook(() => useAddTaskComment(), {
        wrapper: createQueryWrapper(),
      });

      await act(async () => {
        await result.current.mutateAsync({ taskId: 't1', body: 'A comment' });
      });

      expect(mockFrom).toHaveBeenCalledWith('task_comments');
      const insertCall = chain.insert.mock.calls[0][0];
      expect(insertCall.task_id).toBe('t1');
      expect(insertCall.body).toBe('A comment');
      expect(insertCall.user_id).toBe('user-1');
    });
  });
});
