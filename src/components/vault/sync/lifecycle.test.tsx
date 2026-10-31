import { beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => {}) }));

const mem = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
};
const win = new EventTarget();
(globalThis as { window?: unknown }).window = win;

const { SyncOnboardingContent, chooseNotNow } = await import("./SyncOnboardingDialog");
const { SyncBannerView, syncBannerActions } = await import("./SyncBanner");
const { SetupChoice } = await import("../VaultDialog");
const { INDICATOR_TIP_KEY, OPEN_SYNC_POPOVER_EVENT, SYNC_BANNER_KEY, isSyncBannerDone } = await import("../../../lib/syncLifecycle");

type Props = { children?: ReactNode; onClick?: () => void; disabled?: boolean };

/** Text inside an element tree (without rendering child components). */
function text(n: ReactNode): string {
  if (n == null || typeof n === "boolean") return "";
  if (typeof n === "string" || typeof n === "number") return String(n);
  if (Array.isArray(n)) return n.map(text).join("");
  if (isValidElement(n)) return text((n.props as Props).children);
  return "";
}
/** The clickable element whose text is exactly `label`. */
function button(tree: ReactNode, label: string): ReactElement<Props> {
  const found: ReactElement<Props>[] = [];
  const walk = (n: ReactNode) => {
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (!isValidElement(n)) return;
    const p = n.props as Props;
    if (typeof p.onClick === "function" && text(n).trim() === label) found.push(n as ReactElement<Props>);
    walk(p.children);
  };
  walk(tree);
  if (found.length !== 1) throw new Error(`expected one "${label}" button, found ${found.length}`);
  return found[0];
}

beforeEach(() => mem.clear());

describe("post-create step: Use this vault on your other PCs?", () => {
  it("offers Turn on sync with Google Drive (primary) and Not now", () => {
    const onTurnOn = vi.fn();
    const onNotNow = vi.fn();
    const tree = SyncOnboardingContent({ onTurnOn, onNotNow });
    button(tree, "Turn on sync with Google Drive").props.onClick!();
    expect(onTurnOn).toHaveBeenCalledTimes(1);
    button(tree, "Not now").props.onClick!();
    expect(onNotNow).toHaveBeenCalledTimes(1);
    const html = renderToStaticMarkup(<SyncOnboardingContent onTurnOn={() => {}} onNotNow={() => {}} />);
    expect(html).toContain("encrypted before it leaves this PC");
  });

  it("Not now hands the indicator tip to the status bar and closes", () => {
    const close = vi.fn();
    chooseNotNow(close);
    expect(mem.get(INDICATOR_TIP_KEY)).toBe("pending");
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe("vault panel banner: New: sync your vault across PCs", () => {
  it("renders the message with Set up sync and Dismiss", () => {
    const html = renderToStaticMarkup(<SyncBannerView onOpen={() => {}} onDismiss={() => {}} />);
    expect(html).toContain("sync your vault across PCs");
    expect(html).toContain("Set up sync");
    expect(html).toContain('aria-label="Dismiss"');
  });

  it("Dismiss retires it for good without opening anything", () => {
    let opened = 0;
    const on = () => opened++;
    win.addEventListener(OPEN_SYNC_POPOVER_EVENT, on);
    const onDismiss = vi.fn(syncBannerActions.dismiss);
    const tree = SyncBannerView({ onOpen: () => {}, onDismiss });
    const dismiss = (function find(n: ReactNode): (() => void) | undefined {
      if (Array.isArray(n)) { for (const c of n) { const f = find(c); if (f) return f; } return undefined; }
      if (!isValidElement(n)) return undefined;
      const p = n.props as Props & { "aria-label"?: string };
      if (p["aria-label"] === "Dismiss") return p.onClick;
      return find(p.children);
    })(tree);
    dismiss!();
    expect(onDismiss).toHaveBeenCalled();
    expect(isSyncBannerDone()).toBe(true);
    expect(opened).toBe(0);
    win.removeEventListener(OPEN_SYNC_POPOVER_EVENT, on);
  });

  it("Set up sync opens the sync popover and retires the banner", () => {
    let opened = 0;
    const on = () => opened++;
    win.addEventListener(OPEN_SYNC_POPOVER_EVENT, on);
    const tree = SyncBannerView({ onOpen: syncBannerActions.open, onDismiss: () => {} });
    button(tree, "Set up sync").props.onClick!();
    expect(opened).toBe(1);
    expect(mem.get(SYNC_BANNER_KEY)).toBe("done");
    win.removeEventListener(OPEN_SYNC_POPOVER_EVENT, on);
  });
});

describe("vault setup screen", () => {
  it("shows Use my vault from Google Drive as a choice card next to Create a new vault", () => {
    const onUseDrive = vi.fn();
    const html = renderToStaticMarkup(<SetupChoice onUseDrive={onUseDrive} />);
    expect(html).toContain("Create a new vault");
    expect(html).toMatch(/<button[^>]*data-testid="setup-use-drive"[^>]*>.*Use my vault from Google Drive/);
    const tree = SetupChoice({ onUseDrive });
    button(tree, "Use my vault from Google DriveAlready syncing on another PC.").props.onClick!();
    expect(onUseDrive).toHaveBeenCalled();
  });
});
