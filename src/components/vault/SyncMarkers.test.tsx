// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { KeyRound } from "lucide-react";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args?: unknown) => invoke(cmd, args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));
vi.mock("../../lib/vault", async (orig) => ({
  ...(await orig<typeof import("../../lib/vault")>()),
  vaultHistoryList: async () => [{ index: 0, updated: Date.now() - 60_000, size: 40 }],
  vaultHistoryGet: async () => ({ ext: "login", content: OLD }),
  vaultReadFile: async () => ({ ext: "login", content: NEW }),
}));

const OLD = JSON.stringify({ title: "Bank", username: "me", password: "old-pass" });
const NEW = JSON.stringify({ title: "Bank", username: "me@bank", password: "new-pass" });

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { useSyncMarkersStore } = await import("../../lib/syncMarkers");
const { EntryHeader, EntryLayout } = await import("./EntryParts");
const { VaultTree } = await import("./sidebar/VaultTree");
const { RecentlySyncedView } = await import("./sidebar/RecentlySyncedView");
const { buildTree, flattenTree } = await import("../../lib/vaultTree");
const { markerIndex } = await import("../../lib/syncMarkers");
type SyncMarker = import("../../lib/syncMarkers").SyncMarker;
type VaultItem = import("../../lib/vault").VaultItem;
type Tab = import("../../types").Tab;

const NOW = Date.now();
const mk = (rel: string, o: Partial<SyncMarker> = {}): SyncMarker => ({
  id: `id-${rel}`, kind: "updated", fromDevice: "LAPTOP", at: NOW - 2 * 3600_000, rel, dir: false,
  trashed: false, deleted: false, hasBefore: true, beforeIndex: 0, ...o,
});
const item = (rel: string, o: Partial<VaultItem> = {}): VaultItem => ({
  rel, ext: rel.endsWith(".nqv") ? "login" : "", updated: 0, dir: !rel.endsWith(".nqv"),
  tags: [], starred: false, trashed_at: null, ...o,
});
const noop = () => {};

const tree = (marks: SyncMarker[], expanded: boolean) => renderToStaticMarkup(
  <VaultTree
    rows={flattenTree(buildTree([item("Work"), item("Work/bank.nqv"), item("new.nqv"), item("plain.nqv")]), () => expanded)}
    starred={[]} starredOpen={false} onStarredOpen={noop} isExpanded={() => expanded}
    selectedKey={null} openRels={new Set()} editingKey={null} renderEditor={() => null} creating={null}
    empty={<p>empty</p>} onSelectKey={noop} onActivate={noop} onToggle={noop}
    onRename={noop} onTrash={noop} onMenu={noop} onMove={noop}
    marks={markerIndex(marks)}
  />,
);

describe("sidebar dots", () => {
  const marks = [mk("Work/bank.nqv"), mk("new.nqv", { kind: "added", fromDevice: "" })];

  it("shows a dot with a label on marked rows only", () => {
    const html = tree(marks, true);
    expect((html.match(/data-sync-mark="entry"/g) ?? []).length).toBe(2);
    expect(html).toContain("bank, Login, Updated from Drive · from LAPTOP · 2 hours ago");
    expect(html).toContain("New from Drive · 2 hours ago");
    expect(html).not.toContain('data-sync-mark="inside"'); // the folder is open: its child shows its own dot
    expect(html).not.toMatch(/plain[^"]*from Drive/);
  });

  it("shows a hollow dot on a collapsed folder holding marked items", () => {
    const html = tree(marks, false);
    expect(html).toContain('data-sync-mark="inside"');
    expect(html).toContain("Work, Folder, 1 item changed by sync");
  });

  it("shows nothing without markers", () => {
    expect(tree([], true)).not.toContain("vt-sync-dot");
  });
});

let host: HTMLDivElement;
let root: Root;
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const button = (text: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
const click = (el: Element) => act(async () => { (el as HTMLElement).click(); });

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "sync_marker_before") return { ext: "login", content: OLD };
    return undefined;
  });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1200);
  const m = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); },
    removeItem: (k: string) => { m.delete(k); }, clear: () => m.clear(),
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const renderEntry = async (rel: string) => {
  const tab = { id: "t1", title: "Bank", filePath: `C:/Vault/${rel}`, content: NEW, isDirty: false } as unknown as Tab;
  await act(async () => {
    root.render(<EntryLayout tab={tab}><EntryHeader icon={KeyRound} title="Login" tab={tab} /></EntryLayout>);
  });
  await flush();
};

describe("entry banner", () => {
  it("says what came from Drive, marks the entry as seen and shows the field changes", async () => {
    useSyncMarkersStore.setState({ markers: [mk("Work/bank.nqv")], opened: {}, loaded: true });
    await renderEntry("Work/bank.nqv");
    const banner = document.querySelector('[data-sync-banner="updated"]')!;
    expect(banner.textContent).toContain("Updated from Drive · from LAPTOP · 2 hours ago");
    expect(banner.getAttribute("role")).toBe("status");
    // seen: the sidebar dot goes, the banner stays
    expect(invoke).toHaveBeenCalledWith("sync_marker_clear", { id: "id-Work/bank.nqv" });
    expect(useSyncMarkersStore.getState().markers).toEqual([]);

    await click(button("Show changes")!);
    await flush();
    const diff = document.querySelector('[data-testid="sync-diff"]')!;
    expect(document.querySelector('[aria-label="Changes from Drive"]')?.textContent).toContain("2 fields changed, 1 unchanged");
    expect(diff.querySelectorAll('[data-diff="changed"]').length).toBe(2);
    expect(diff.textContent).toContain("me@bank");
    expect(diff.textContent).not.toContain("new-pass"); // secrets masked
    await click(button("Reveal")!);
    expect(diff.textContent).toContain("old-pass");
    expect(diff.textContent).toContain("new-pass");
    expect(document.body.textContent).toContain("Before sync"); // the pre-sync version in the list

    await click(button("Dismiss")!);
    expect(document.querySelector("[data-sync-banner]")).toBeNull();
  });

  it("a new entry says Added from Drive, with nothing to compare", async () => {
    useSyncMarkersStore.setState({ markers: [mk("new.nqv", { kind: "added", hasBefore: false, beforeIndex: null })], opened: {}, loaded: true });
    await renderEntry("new.nqv");
    expect(document.querySelector('[data-sync-banner="added"]')?.textContent).toContain("Added from Drive · from LAPTOP");
    expect(button("Show changes")).toBeUndefined();
  });

  it("shows nothing for an unmarked entry", async () => {
    useSyncMarkersStore.setState({ markers: [mk("other.nqv")], opened: {}, loaded: true });
    await renderEntry("bank.nqv");
    expect(document.querySelector("[data-sync-banner]")).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith("sync_marker_clear", expect.anything());
  });
});

describe("Recently synced view", () => {
  it("lists what came from Drive and marks all as seen", async () => {
    const onOpen = vi.fn();
    const onMarkAllSeen = vi.fn();
    await act(async () => {
      root.render(
        <RecentlySyncedView
          markers={[mk("Work/bank.nqv"), mk("gone.nqv", { deleted: true }), mk("new.nqv", { kind: "added", at: NOW })]}
          items={[item("Work/bank.nqv"), item("new.nqv")]}
          onBack={noop} onOpen={onOpen} onMarkAllSeen={onMarkAllSeen} now={NOW}
        />,
      );
    });
    const rows = [...document.querySelectorAll('[role="listitem"]')];
    expect(rows.map((r) => r.getAttribute("aria-label"))).toEqual([
      "new, New from Drive · from LAPTOP · just now. Open",
      "bank, Updated from Drive · from LAPTOP · 2 hours ago. Open",
    ]);
    await click(rows[1]);
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ rel: "Work/bank.nqv" }));
    await click(button("Mark all as seen")!);
    expect(onMarkAllSeen).toHaveBeenCalled();
  });

  it("has an empty state", async () => {
    await act(async () => {
      root.render(<RecentlySyncedView markers={[]} items={[]} onBack={noop} onOpen={noop} onMarkAllSeen={noop} />);
    });
    expect(document.body.textContent).toContain("Nothing new from Drive");
    expect(button("Mark all as seen")).toBeUndefined();
  });
});
