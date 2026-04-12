import { Component, ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

/**
 * Error boundary that wraps Joe (AI assistant) UI so a runtime error inside
 * an Ask Joe dialog can never crash the parent page. The fallback message is
 * intentionally minimal — toasts and chat-message fallbacks already handle
 * the common Joe failure paths.
 */
export class JoeErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: unknown) {
    // eslint-disable-next-line no-console
    console.error('JoeErrorBoundary caught:', error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="p-6 text-center text-sm text-muted-foreground">
          Joe hit a snag — please reopen.
        </div>
      );
    }
    return this.props.children;
  }
}
