import { Component, type ErrorInfo, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** One short line for the error row (never a stack, never more than ~120 chars). */
export function quickErrorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const line = raw.split("\n")[0].trim();
  if (!line) return "Something went wrong.";
  return line.length > 120 ? `${line.slice(0, 117)}…` : line;
}

/** Hides the window and hands the focus back (same as Esc in the working window). */
const hideQuick = () => invoke("quick_search_hide", { restore: true }).catch(() => {});

/** The quick window's "Loading…" state while its code chunk loads (never a blank page). */
export function QuickLoading() {
  return (
    <div className="h-screen flex items-center justify-center bg-[var(--color-bg-secondary)] text-[var(--color-text-muted)] text-xs border border-[var(--color-border)]">
      Loading…
    </div>
  );
}

/** The minimal error row shown instead of a stuck blank page. */
export function QuickErrorFallback({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="h-screen flex flex-col items-center justify-center gap-2 p-6 text-center bg-[var(--color-bg-secondary)] text-[var(--color-text)] border border-[var(--color-border)]"
    >
      <p className="text-sm font-semibold">Quick search hit a problem</p>
      <p className="text-xs text-[var(--color-text-muted)] max-w-full truncate">{message}</p>
      <div className="flex items-center gap-2 mt-1">
        <button
          type="button"
          autoFocus
          className="px-3 py-1.5 rounded-md text-xs font-medium bg-[var(--color-primary)] text-white hover:opacity-90"
          onClick={onRetry}
        >
          Try again
        </button>
        <button
          type="button"
          className="px-3 py-1.5 rounded-md text-xs border border-[var(--color-border)] hover:bg-[var(--color-bg-tertiary)]"
          onClick={() => void hideQuick()}
        >
          Close
        </button>
      </div>
      <p className="text-[11px] text-[var(--color-text-muted)]"><kbd>Esc</kbd> close</p>
    </div>
  );
}

interface State { error: unknown; hasError: boolean }

/**
 * Wraps the quick-search window. A render error (or a failed chunk load) logs itself and shows a
 * minimal error row: Esc / Close / an outside click (Rust's blur hide) still close the window, and
 * the next hide or show remounts the app fresh, so the window never stays stuck on a blank page.
 */
export class QuickErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null, hasError: false };
  private unsubs: Promise<() => void>[] = [];

  static getDerivedStateFromError(error: unknown): State {
    return { error, hasError: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("quick search crashed:", error, info.componentStack);
  }

  componentDidMount() {
    window.addEventListener("keydown", this.onKey);
    const reset = () => { if (this.state.hasError) this.reset(); };
    this.unsubs = [listen("quick-search:hidden", reset), listen("quick-search:shown", reset)];
    for (const u of this.unsubs) u.catch(() => {});
  }

  componentWillUnmount() {
    window.removeEventListener("keydown", this.onKey);
    this.unsubs.forEach((p) => p.then((un) => un()).catch(() => {}));
  }

  reset = () => this.setState({ error: null, hasError: false });

  private onKey = (e: KeyboardEvent) => {
    // The app's own Esc handler is gone with its tree: close from here while in the error state.
    if (this.state.hasError && e.key === "Escape") { e.preventDefault(); void hideQuick(); }
  };

  render() {
    if (this.state.hasError) return <QuickErrorFallback message={quickErrorText(this.state.error)} onRetry={this.reset} />;
    return this.props.children;
  }
}
