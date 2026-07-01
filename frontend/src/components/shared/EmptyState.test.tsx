import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DataErrorState, QueryRetryButton } from './EmptyState';

describe('DataErrorState', () => {
  it('shows data-source failure copy and calls retry', () => {
    const onRetry = vi.fn();

    render(
      <DataErrorState
        error={new Error('Supabase timed out')}
        onRetry={onRetry}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Data source unavailable');
    expect(screen.getByText('Supabase timed out')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe('QueryRetryButton', () => {
  it('does not render without a retry action', () => {
    const { container } = render(<QueryRetryButton />);
    expect(container).toBeEmptyDOMElement();
  });
});
