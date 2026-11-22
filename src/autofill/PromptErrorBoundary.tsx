import { Component, type ErrorInfo, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";

interface State { hasError: boolean }

/**
 * Wraps the autofill approval window. A render error or a failed code chunk would otherwise leave the
 * window as an empty white rectangle with nothing to click: this shows a short message and a Close button
 * (and Esc) that hides the window again. The request itself ends by Rust's own timeout.
 */
export class PromptErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("autofill prompt crashed:", error, info.componentStack);
  }

  componentDidMount() {
    window.addEventListener("keydown", this.onKey);
  }

  componentWillUnmount() {
    window.removeEventListener("keydown", this.onKey);
  }

  private close = () => {
    this.setState({ hasError: false });
    void invoke("autofill_prompt_hide", { restore: true }).catch(() => {});
  };

  private onKey = (e: KeyboardEvent) => {
    if (this.state.hasError && e.key === "Escape") { e.preventDefault(); this.close(); }
  };

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <div
        role="alert"
        className="h-screen flex flex-col items-center justify-center gap-2 p-6 text-center bg-[var(--color-bg-secondary)] text-[var(--color-text)] border border-[var(--color-border)]"
      >
        <p className="text-sm font-semibold">Autofill hit a problem</p>
        <p className="text-xs text-[var(--color-text-muted)]">Close this window and try again from the browser.</p>
        <button
          type="button"
          autoFocus
          className="mt-1 px-3 py-1.5 rounded-md text-xs font-medium bg-[var(--color-primary)] text-[var(--color-on-primary)] hover:opacity-90"
          onClick={this.close}
        >
          Close
        </button>
      </div>
    );
  }
}
