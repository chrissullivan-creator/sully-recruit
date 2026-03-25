import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { createQueryWrapper } from '@/test/helpers';

// ─── Mock Supabase ────────────────────────────────────────────────────────────

const mockSelect = vi.fn();
const mockOrder = vi.fn();
const mockEq = vi.fn();
const mockNot = vi.fn();
const mockLimit = vi.fn();
const mockMaybeSingle = vi.fn();
const mockIn = vi.fn();

function createChain(data: any = [], error: any = null) {
  const result = { data, error };
  const chain: any = {
    select: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    not: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue(result),
    then: undefined,
  };
  // Make chain itself resolve to result when awaited
  chain.select.mockReturnValue(chain);
  chain.order.mockReturnValue(chain);
  chain.eq.mockReturnValue(chain);
  chain.not.mockReturnValue(chain);
  chain.limit.mockReturnValue(chain);
  chain.in.mockReturnValue(chain);

  // Make the chain thenable (so await works)
  const promise = Promise.resolve(result);
  chain.then = promise.then.bind(promise);
  chain.catch = promise.catch.bind(promise);

  return chain;
}

const mockFrom = vi.fn();
const mockGetUser = vi.fn();
const mockChannel = vi.fn().mockReturnValue({
  on: vi.fn().mockReturnThis(),
  subscribe: vi.fn().mockReturnThis(),
});
const mockRemoveChannel = vi.fn();

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (...args: any[]) => mockFrom(...args),
    auth: {
      getUser: () => mockGetUser(),
    },
    channel: (...args: any[]) => mockChannel(...args),
    removeChannel: (...args: any[]) => mockRemoveChannel(...args),
  },
}));

// ─── Import hooks after mock ──────────────────────────────────────────────────

import {
  useCompanies,
  useJobs,
  useCandidate,
  useNotes,
  useDashboardMetrics,
} from './useData';

describe('useData hooks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('useCompanies', () => {
    it('fetches companies and computes job_count', async () => {
      const companiesData = [
        { id: '1', name: 'Acme', created_at: '2024-01-01', jobs: [{ id: 'j1' }, { id: 'j2' }] },
        { id: '2', name: 'BigCorp', created_at: '2024-01-02', jobs: [] },
        { id: '3', name: 'NullJobs', created_at: '2024-01-03', jobs: null },
      ];
      mockFrom.mockReturnValue(createChain(companiesData));

      const { result } = renderHook(() => useCompanies(), {
        wrapper: createQueryWrapper(),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(result.current.data).toHaveLength(3);
      expect(result.current.data![0].job_count).toBe(2);
      expect(result.current.data![1].job_count).toBe(0);
      expect(result.current.data![2].job_count).toBe(0);
    });
  });

  describe('useJobs', () => {
    it('fetches jobs and calls .not() when includesClosed is false', async () => {
      const chain = createChain([{ id: 'j1', title: 'Engineer' }]);
      mockFrom.mockReturnValue(chain);

      const { result } = renderHook(() => useJobs(false), {
        wrapper: createQueryWrapper(),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(chain.not).toHaveBeenCalledWith('status', 'in', '("lost","closed")');
    });

    it('does not filter when includesClosed is true', async () => {
      const chain = createChain([{ id: 'j1', title: 'Engineer' }]);
      mockFrom.mockReturnValue(chain);

      const { result } = renderHook(() => useJobs(true), {
        wrapper: createQueryWrapper(),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(chain.not).not.toHaveBeenCalled();
    });
  });

  describe('useCandidate', () => {
    it('does not fetch when id is undefined', async () => {
      const { result } = renderHook(() => useCandidate(undefined), {
        wrapper: createQueryWrapper(),
      });

      // Should not be loading because query is disabled
      await waitFor(() => expect(result.current.fetchStatus).toBe('idle'));
      expect(mockFrom).not.toHaveBeenCalled();
    });

    it('fetches candidate when id is provided', async () => {
      const chain = createChain({ id: 'c1', full_name: 'John Doe' });
      mockFrom.mockReturnValue(chain);

      const { result } = renderHook(() => useCandidate('c1'), {
        wrapper: createQueryWrapper(),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockFrom).toHaveBeenCalledWith('candidates');
    });
  });

  describe('useNotes', () => {
    it('does not fetch when entityId is undefined', async () => {
      const { result } = renderHook(() => useNotes(undefined, 'candidate'), {
        wrapper: createQueryWrapper(),
      });

      await waitFor(() => expect(result.current.fetchStatus).toBe('idle'));
      expect(mockFrom).not.toHaveBeenCalled();
    });
  });

  describe('useDashboardMetrics', () => {
    it('aggregates metrics from multiple tables', async () => {
      mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } } });

      const jobsChain = createChain([], null);
      jobsChain.count = 5;
      // Override the then to return the count
      const jobsResult = { data: [], error: null, count: 5 };
      const jobsPromise = Promise.resolve(jobsResult);
      jobsChain.then = jobsPromise.then.bind(jobsPromise);
      jobsChain.catch = jobsPromise.catch.bind(jobsPromise);

      const candidatesData = [
        { id: 'c1', job_status: 'new', owner_id: 'user-1' },
        { id: 'c2', job_status: 'new', owner_id: 'user-2' },
        { id: 'c3', job_status: 'reached_out', owner_id: 'user-1' },
        { id: 'c4', job_status: 'pitched', owner_id: 'user-1' },
      ];
      const candChain = createChain(candidatesData);

      const sendOutsData = [
        { id: 's1', stage: 'interview' },
        { id: 's2', stage: 'offer' },
        { id: 's3', stage: 'interview' },
      ];
      const sendOutsChain = createChain(sendOutsData);

      let callCount = 0;
      mockFrom.mockImplementation((table: string) => {
        if (table === 'jobs') return jobsChain;
        if (table === 'candidates') return candChain;
        if (table === 'send_outs') return sendOutsChain;
        return createChain();
      });

      const { result } = renderHook(() => useDashboardMetrics(), {
        wrapper: createQueryWrapper(),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      const metrics = result.current.data!;
      expect(metrics.totalCandidates).toBe(4);
      expect(metrics.myCandidates).toBe(3);
      expect(metrics.newCandidates).toBe(2);
      expect(metrics.contactedCandidates).toBe(1);
      expect(metrics.pitchedCandidates).toBe(1);
      expect(metrics.interviewsThisWeek).toBe(2);
      expect(metrics.offersOut).toBe(1);
    });
  });
});
