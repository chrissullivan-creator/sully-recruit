import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Contacts from './Contacts';

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

vi.mock('@/components/CsvImportDialog', () => ({
  CsvImportDialog: () => null,
}));

vi.mock('@/components/contacts/AddContactDialog', () => ({
  AddContactDialog: () => null,
}));

vi.mock('@/components/candidates/EnrollInSequenceDialog', () => ({
  EnrollInSequenceDialog: () => null,
}));

vi.mock('@/components/candidates/AskJoeAdvancedSearch', () => ({
  AskJoeAdvancedSearch: () => null,
}));

vi.mock('@/components/contacts/AskJoeContactSearch', () => ({
  AskJoeContactSearch: () => null,
}));

vi.mock('@/components/tasks/TaskSlidePanel', () => ({
  TaskSlidePanel: () => null,
}));

vi.mock('@/components/shared/CompanyLogo', () => ({
  CompanyLogo: () => <div data-testid="company-logo" />,
}));

vi.mock('@/hooks/useData', () => ({
  useContacts: () => ({
    data: [
      {
        id: 'contact-1',
        full_name: 'Alex Recruiter',
        first_name: 'Alex',
        last_name: 'Recruiter',
        title: 'Hiring Manager',
        status: 'active',
        email: 'alex@example.com',
        phone: '555-0100',
        linkedin_url: 'https://linkedin.com/in/alex-recruiter',
        updated_at: '2026-04-01T00:00:00.000Z',
        created_at: '2026-03-01T00:00:00.000Z',
        companies: { name: 'Acme', domain: 'acme.com' },
      },
    ],
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
  useJobs: () => ({
    data: [],
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

function renderContacts() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Contacts />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('Contacts page', () => {
  beforeEach(() => {
    navigateMock.mockReset();
  });

  it('does not trigger row navigation when clicking the email action', () => {
    renderContacts();

    const emailLink = screen.getByRole('link', { name: /email alex recruiter/i });
    emailLink.addEventListener('click', (event) => event.preventDefault());
    fireEvent.click(emailLink);

    expect(emailLink).toHaveAttribute('href', 'mailto:alex@example.com');
    expect(navigateMock).not.toHaveBeenCalled();
  });
});
