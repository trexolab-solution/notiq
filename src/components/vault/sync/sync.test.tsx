import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => {}) }));

// The dialog module imports the app store, which reads localStorage at load time (node has none).
const mem = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage ??= {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
};

const { AdoptChoiceList, ADOPT_CHOICES } = await import("./AdoptRemoteDialog");
const { SyncIndicator, SyncIndicatorButton } = await import("../../layout/SyncIndicator");
const { DEFAULT_ADOPT_CHOICE } = await import("../../../lib/vaultSyncFlows");
const { syncIndicator } = await import("../../../lib/vaultSync");
const { SyncStatusFallback } = await import("../../ui/settings/SyncSection");
type SyncStatus = import("../../../lib/vaultSync").SyncStatus;

const noop = () => {};
const status = (o: Partial<SyncStatus> = {}): SyncStatus => ({
  configured: true, provider: "gdrive", account: "me@gmail.com", enabled: true, state: "idle",
  lastSyncedMs: null, lastError: null, pending: false, deviceId: "d1", deviceName: "Desk", ...o,
});

describe("A/B/C choice list", () => {
  it("offers A, B and C in order, with A checked by default", () => {
    const html = renderToStaticMarkup(<AdoptChoiceList choice={DEFAULT_ADOPT_CHOICE} onChange={noop} />);
    expect(ADOPT_CHOICES.map((c) => c.value)).toEqual(["import", "backupOnly", "cancel"]);
    expect(html).toContain("A. Import this PC&#x27;s vault into the synced vault");
    expect(html).toContain("B. Back up this PC&#x27;s vault to a file, then use the synced vault");
    expect(html).toContain("C. Cancel");
    const radios = html.match(/<input[^>]*type="radio"[^>]*>/g) ?? [];
    expect(radios).toHaveLength(3);
    expect(radios[0]).toContain('value="import"');
    expect(radios[0]).toContain("checked");
    expect(radios[1]).not.toContain("checked");
    expect(radios[2]).not.toContain("checked");
  });

  it("explains skipped and renamed entries for A", () => {
    const html = renderToStaticMarkup(<AdoptChoiceList choice="import" onChange={noop} />);
    expect(html).toContain("Identical logins are skipped");
    expect(html).toContain("(This PC)");
  });
});

describe("status bar sync indicator", () => {
  it("renders nothing while sync is off", () => {
    expect(renderToStaticMarkup(<SyncIndicator status={status({ enabled: false, state: "off" })} onOpen={noop} />)).toBe("");
    expect(renderToStaticMarkup(<SyncIndicator status={null} onOpen={noop} />)).toBe("");
  });

  it.each([
    [{ state: "idle" }, "synced", "Synced"],
    [{ state: "syncing" }, "syncing", "Syncing"],
    [{ state: "offline" }, "offline", "Offline"],
    [{ state: "error", lastError: "x" }, "problem", "Sync problem"],
    [{ state: "authNeeded" }, "problem", "Sync problem"],
    [{ state: "locked" }, "locked", "Sync paused"],
  ] as [Partial<SyncStatus>, string, string][])("%o → %s", (o, kind, label) => {
    const html = renderToStaticMarkup(<SyncIndicator status={status(o)} onOpen={noop} />);
    expect(html).toContain(`data-sync-state="${kind}"`);
    expect(html).toContain(`status-sync--${kind}`);
    expect(html).toContain(`<span>${label}</span>`);
    expect(html).toMatch(/aria-label="Vault sync: [^"]+"/);
  });

  it("is a real button", () => {
    const html = renderToStaticMarkup(<SyncIndicatorButton ind={syncIndicator(status())!} onOpen={noop} />);
    expect(html).toMatch(/^<button type="button"/);
  });
});

describe("Settings sync row before the status is known", () => {
  it("shows Checking… while loading", () => {
    const html = renderToStaticMarkup(<SyncStatusFallback error={null} onRetry={noop} />);
    expect(html).toContain("Checking sync…");
    expect(html).not.toContain("Retry");
  });

  it("shows the error and a Retry button when sync_status failed", () => {
    const html = renderToStaticMarkup(<SyncStatusFallback error="You're offline" onRetry={noop} />);
    expect(html).toContain("Couldn&#x27;t check sync: You&#x27;re offline");
    expect(html).toMatch(/<button[^>]*>.*Retry<\/button>/);
    expect(html).not.toContain("Checking sync…");
  });
});
