import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// ─── Mock dependencies ────────────────────────────────────────────────────────

vi.mock('@/hooks/useData', () => ({
  useJobs: () => ({
    data: [
      { id: 'job-1', title: 'Software Engineer', company_name: 'Acme', companies: { name: 'Acme' } },
      { id: 'job-2', title: 'Product Manager', company_name: 'BigCorp', companies: { name: 'BigCorp' } },
    ],
  }),
  useSequences: () => ({
    data: [
      { id: 'seq-1', name: 'Outreach Campaign', status: 'active' },
      { id: 'seq-2', name: 'Archived Campaign', status: 'archived' },
    ],
  }),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }) },
    from: vi.fn().mockReturnValue({
      insert: vi.fn().mockReturnThis(),
      update: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      then: (cb: any) => cb({ data: [], error: null }),
    }),
  },
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { BulkCandidateActionsDialog } from './BulkCandidateActionsDialog';

function renderDialog(props: Partial<React.ComponentProps<typeof BulkCandidateActionsDialog>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BulkCandidateActionsDialog
        open={true}
        onOpenChange={vi.fn()}
        candidateIds={['c1', 'c2', 'c3']}
        candidateNames={['Alice', 'Bob', 'Charlie']}
        {...props}
      />
    </QueryClientProvider>
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('BulkCandidateActionsDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('displays candidate count', () => {
    renderDialog();
    expect(screen.getByText('3 candidates selected')).toBeInTheDocument();
  });

  it('shows candidate names preview in description', () => {
    renderDialog();
    expect(screen.getByText(/Alice, Bob, Charlie/)).toBeInTheDocument();
  });

  it('renders Apply Actions button as disabled initially (no job selected)', () => {
    renderDialog();
    const button = screen.getByRole('button', { name: /Apply Actions/i });
    expect(button).toBeDisabled();
  });

  it('does not render when open is false', () => {
    renderDialog({ open: false });
    expect(screen.queryByText('Bulk Candidate Actions')).not.toBeInTheDocument();
  });

  it('shows singular "candidate" for single selection', () => {
    renderDialog({ candidateIds: ['c1'], candidateNames: ['Alice'] });
    expect(screen.getByText('1 candidate selected')).toBeInTheDocument();
  });

  it('truncates names preview when more than 3 candidates', () => {
    renderDialog({
      candidateIds: ['c1', 'c2', 'c3', 'c4'],
      candidateNames: ['Alice', 'Bob', 'Charlie', 'Dan'],
    });
    expect(screen.getByText(/Alice, Bob, Charlie.../)).toBeInTheDocument();
  });
});
