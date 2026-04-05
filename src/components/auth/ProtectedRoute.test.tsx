import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ProtectedRoute } from './ProtectedRoute';

// ─── Mock useAuth ─────────────────────────────────────────────────────────────

const mockUseAuth = vi.fn();

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}));

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ProtectedRoute', () => {
  it('shows loading spinner when auth is loading', () => {
    mockUseAuth.mockReturnValue({ user: null, loading: true });

    render(
      <MemoryRouter>
        <ProtectedRoute>
          <div>Protected Content</div>
        </ProtectedRoute>
      </MemoryRouter>
    );

    expect(screen.getByText('Loading...')).toBeInTheDocument();
    expect(screen.queryByText('Protected Content')).not.toBeInTheDocument();
  });

  it('redirects to /auth when no user', () => {
    mockUseAuth.mockReturnValue({ user: null, loading: false });

    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <ProtectedRoute>
          <div>Protected Content</div>
        </ProtectedRoute>
      </MemoryRouter>
    );

    expect(screen.queryByText('Protected Content')).not.toBeInTheDocument();
  });

  it('renders children when user is authenticated', () => {
    mockUseAuth.mockReturnValue({
      user: { id: '123', email: 'test@test.com' },
      loading: false,
    });

    render(
      <MemoryRouter>
        <ProtectedRoute>
          <div>Protected Content</div>
        </ProtectedRoute>
      </MemoryRouter>
    );

    expect(screen.getByText('Protected Content')).toBeInTheDocument();
  });
});
