import { Component, type ErrorInfo, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';

interface State {
  error: Error | null;
}

/**
 * Last-resort error screen (row 12: no silent failures, no blank screens). Work is not lost: every
 * committed edit is already in the autosave journal and is recovered on reload.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('UI error', error, info.componentStack);
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex h-full items-center justify-center p-6" role="alert" data-testid="error-screen">
        <div className="max-w-lg space-y-3">
          <h1 className="text-lg font-semibold">Something went wrong in the interface</h1>
          <p className="text-muted-foreground text-sm">
            Your work is safe: every change has been saved automatically and will be restored when the app
            reloads.
          </p>
          <pre className="bg-muted overflow-auto rounded-md p-2 text-xs whitespace-pre-wrap">
            {this.state.error.message}
          </pre>
          <div className="flex gap-2">
            <Button onClick={() => location.reload()}>Reload the app</Button>
            <Button variant="outline" onClick={() => this.setState({ error: null })}>
              Try to continue
            </Button>
          </div>
        </div>
      </div>
    );
  }
}
