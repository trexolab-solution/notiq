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
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "center",
          height: "100%", padding: 24, color: "var(--color-text-muted)",
          fontSize: 13, textAlign: "center",
        }}>
          <div>
            <p style={{ fontWeight: 600, marginBottom: 8, color: "var(--color-danger)" }}>
              Something went wrong
            </p>
            <p style={{ opacity: 0.7, fontSize: 12 }}>
              {this.state.error?.message ?? "An unexpected error occurred."}
            </p>
            <button
              onClick={() => this.setState({ hasError: false, error: null })}
              style={{
                marginTop: 12, padding: "4px 12px", borderRadius: 4, fontSize: 12,
                cursor: "pointer", background: "var(--color-bg-tertiary)",
                color: "var(--color-text)", border: "1px solid var(--color-border)",
              }}
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
