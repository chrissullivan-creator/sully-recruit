import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import Jobs from './Jobs';

const navigateMock = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

vi.mock('@/components/layout/MainLayout', () => ({
  MainLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/components/layout/PageHeader', () => ({
  PageHeader: ({ title, actions }: { title: string; actions?: React.ReactNode }) => (
    <div>
      <h1>{title}</h1>
      {actions}
    </div>
  ),
}));

vi.mock('@/components/pipeline/JobPipeline', () => ({
  JobPipeline: () => <div>Pipeline board</div>,
}));

vi.mock('@/components/jobs/AddJobDialog', () => ({
  AddJobDialog: () => null,
}));

vi.mock('@/components/CsvImportDialog', () => ({
  CsvImportDialog: () => null,
}));

vi.mock('@/components/tasks/TaskSlidePanel', () => ({
  TaskSlidePanel: () => null,
}));

vi.mock('@/components/shared/CompanyLogo', () => ({
  CompanyLogo: () => <div data-testid="company-logo" />,
}));

vi.mock('@/hooks/useData', () => ({
  useJobs: () => ({
    data: [
      {
        id: 'job-1',
        title: 'Staff Recruiter',
        company_name: 'Acme',
        location: 'Remote',
        status: 'hot',
        num_openings: 2,
        job_code: 'AC-1',
        companies: { name: 'Acme', domain: 'acme.com', logo_url: null },
      },
    ],
    isLoading: false,
  }),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: vi.fn(),
  },
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

function renderJobs() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Jobs />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('Jobs page', () => {
  it('switches between pipeline and list views with accessible toggle buttons', () => {
    renderJobs();

    const pipelineButton = screen.getByRole('button', { name: /pipeline view/i });
    const listButton = screen.getByRole('button', { name: /list view/i });

    expect(pipelineButton).toHaveAttribute('aria-pressed', 'true');
    expect(listButton).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText('Pipeline board')).toBeInTheDocument();

    fireEvent.click(listButton);

    expect(pipelineButton).toHaveAttribute('aria-pressed', 'false');
    expect(listButton).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Staff Recruiter')).toBeInTheDocument();
  });
});
