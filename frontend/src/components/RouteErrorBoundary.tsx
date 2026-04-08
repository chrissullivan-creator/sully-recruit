import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class RouteErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[RouteErrorBoundary] Uncaught error:', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      const { error } = this.state;
      return (
        <div className="flex items-center justify-center min-h-[60vh] p-8">
          <div className="max-w-lg w-full text-center">
            <AlertTriangle className="h-12 w-12 mx-auto text-destructive mb-4" />
            <h2 className="text-lg font-semibold text-foreground mb-2">Something went wrong</h2>
            <p className="text-sm text-muted-foreground mb-4">
              This page crashed. The error details below can help diagnose the issue.
            </p>
            <div className="rounded-lg border border-destructive/20 bg-destructive/5 p-4 mb-6 text-left">
              <p className="text-sm font-mono text-destructive break-all">
                {error?.message || 'Unknown error'}
              </p>
              {error?.stack && (
                <pre className="text-xs text-muted-foreground mt-2 overflow-x-auto max-h-40 whitespace-pre-wrap">
                  {error.stack}
                </pre>
              )}
            </div>
            <button
              onClick={() => window.location.reload()}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
            >
              <RefreshCw className="h-4 w-4" />
              Reload Page
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
