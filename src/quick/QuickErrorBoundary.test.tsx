import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const invoke = vi.fn(async () => null);
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));

const { QuickErrorBoundary, QuickErrorFallback, QuickLoading, quickErrorText } = await import("./QuickErrorBoundary");

describe("quickErrorText", () => {
  it("keeps one short line", () => {
    expect(quickErrorText(new Error("boom\n    at x (y.js:1)"))).toBe("boom");
    expect(quickErrorText("plain")).toBe("plain");
    expect(quickErrorText(undefined)).toBe("Something went wrong.");
    expect(quickErrorText(new Error("   "))).toBe("Something went wrong.");
    const long = quickErrorText(new Error("x".repeat(500)));
    expect(long.length).toBe(118);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("QuickErrorBoundary", () => {
  it("switches to the error state on a render error", () => {
    const err = new Error("totp exploded");
    expect(QuickErrorBoundary.getDerivedStateFromError(err)).toEqual({ error: err, hasError: true });
  });

  it("renders the children until something fails", () => {
    const html = renderToStaticMarkup(<QuickErrorBoundary><p>search box</p></QuickErrorBoundary>);
    expect(html).toBe("<p>search box</p>");
  });

  it("renders a recoverable error row instead of a blank page", () => {
    const b = new QuickErrorBoundary({ children: <p>search box</p> });
    b.state = QuickErrorBoundary.getDerivedStateFromError(new Error("totp exploded"));
    const html = renderToStaticMarkup(<>{b.render()}</>);
    expect(html).toContain('role="alert"');
    expect(html).toContain("Quick search hit a problem");
    expect(html).toContain("totp exploded");
    expect(html).toContain("Try again");
    expect(html).toContain("Close");
    expect(html).not.toContain("search box");
  });

  it("Try again clears the error", () => {
    const b = new QuickErrorBoundary({ children: null });
    const set = vi.fn();
    b.setState = set as never;
    b.reset();
    expect(set).toHaveBeenCalledWith({ error: null, hasError: false });
  });

  it("the fallback and the loading state are never empty", () => {
    expect(renderToStaticMarkup(<QuickErrorFallback message="m" onRetry={() => {}} />)).toContain("Esc");
    expect(renderToStaticMarkup(<QuickLoading />)).toContain("Loading…");
  });
});
