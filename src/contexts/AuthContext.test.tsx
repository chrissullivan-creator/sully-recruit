import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ─── Mock Supabase ────────────────────────────────────────────────────────────

const { mockAuth } = vi.hoisted(() => {
  const mockAuth = {
    onAuthStateChange: vi.fn(),
    getSession: vi.fn(),
    signUp: vi.fn(),
    signInWithPassword: vi.fn(),
    signOut: vi.fn(),
  };
  return { mockAuth };
});

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { auth: mockAuth },
}));

import { AuthProvider, useAuth } from './AuthContext';

let authChangeCallback: ((event: string, session: any) => void) | null = null;

// ─── Helper to render useAuth ─────────────────────────────────────────────────

function TestConsumer() {
  const auth = useAuth();
  return (
    <div>
      <span data-testid="loading">{String(auth.loading)}</span>
      <span data-testid="user">{auth.user ? auth.user.email : 'null'}</span>
      <button onClick={() => auth.signIn('test@test.com', 'pass')}>Sign In</button>
      <button onClick={() => auth.signUp('test@test.com', 'pass', 'Test User')}>Sign Up</button>
      <button onClick={() => auth.signOut()}>Sign Out</button>
    </div>
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AuthContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authChangeCallback = null;
    mockAuth.onAuthStateChange.mockImplementation((cb: any) => {
      authChangeCallback = cb;
      return { data: { subscription: { unsubscribe: vi.fn() } } };
    });
    mockAuth.getSession.mockResolvedValue({ data: { session: null } });
  });

  it('throws when useAuth is used outside AuthProvider', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<TestConsumer />)).toThrow('useAuth must be used within AuthProvider');
    consoleSpy.mockRestore();
  });

  it('starts in loading state and resolves to no user', async () => {
    render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('loading').textContent).toBe('false');
    });
    expect(screen.getByTestId('user').textContent).toBe('null');
  });

  it('updates user when auth state changes', async () => {
    render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('loading').textContent).toBe('false');
    });

    // Simulate auth state change
    act(() => {
      authChangeCallback?.('SIGNED_IN', {
        user: { email: 'user@test.com', id: '123' },
      });
    });

    expect(screen.getByTestId('user').textContent).toBe('user@test.com');
  });

  it('calls supabase.auth.signInWithPassword on signIn', async () => {
    mockAuth.signInWithPassword.mockResolvedValue({ error: null });
    const user = userEvent.setup();

    render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('loading').textContent).toBe('false');
    });

    await user.click(screen.getByText('Sign In'));
    expect(mockAuth.signInWithPassword).toHaveBeenCalledWith({
      email: 'test@test.com',
      password: 'pass',
    });
  });

  it('calls supabase.auth.signUp on signUp', async () => {
    mockAuth.signUp.mockResolvedValue({ error: null });
    const user = userEvent.setup();

    render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('loading').textContent).toBe('false');
    });

    await user.click(screen.getByText('Sign Up'));
    expect(mockAuth.signUp).toHaveBeenCalledWith({
      email: 'test@test.com',
      password: 'pass',
      options: {
        data: { display_name: 'Test User' },
        emailRedirectTo: window.location.origin,
      },
    });
  });

  it('calls supabase.auth.signOut on signOut', async () => {
    mockAuth.signOut.mockResolvedValue({});
    const user = userEvent.setup();

    render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('loading').textContent).toBe('false');
    });

    await user.click(screen.getByText('Sign Out'));
    expect(mockAuth.signOut).toHaveBeenCalled();
  });

  it('loads existing session on mount', async () => {
    mockAuth.getSession.mockResolvedValue({
      data: {
        session: { user: { email: 'existing@test.com', id: 'abc' } },
      },
    });

    render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('user').textContent).toBe('existing@test.com');
    });
  });
});
