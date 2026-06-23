import React from "react";

interface Props {
  fallback?: React.ReactNode;
  children: React.ReactNode;
  /** When this key changes, the error state resets automatically. */
  resetKey?: string | number;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("ErrorBoundary caught:", error, info.componentStack);
  }

  componentDidUpdate(prevProps: Props) {
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false, error: null });
    }
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback ?? (
        <div className="flex items-center justify-center h-full p-6 text-[var(--color-text-muted)] text-[13px] text-center">
          <div>
            <p className="font-semibold mb-2 text-[var(--color-danger)]">
              Something went wrong
            </p>
            <p className="opacity-70 text-[12px]">
              {this.state.error?.message ?? "An unexpected error occurred."}
            </p>
            <button
              onClick={() => this.setState({ hasError: false, error: null })}
              className="mt-3 py-1 px-3 rounded text-[12px] cursor-pointer bg-[var(--color-bg-tertiary)] text-[var(--color-text)] border border-[var(--color-border)]"
            >
              Try again
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
