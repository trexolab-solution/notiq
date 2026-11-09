import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args?: unknown) => invoke(cmd, args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));

const {
  markerLabel, markerIndex, markedInside, relOfPath, reviewActions, reviewList, useSyncMarkersStore,
} = await import("./syncMarkers");
type SyncMarker = import("./syncMarkers").SyncMarker;

const NOW = 1_800_000_000_000;
const mk = (rel: string, o: Partial<SyncMarker> = {}): SyncMarker => ({
  id: `id-${rel}`, kind: "updated", fromDevice: "LAPTOP", at: NOW - 2 * 3600_000, rel, dir: false,
  trashed: false, deleted: false, hasBefore: true, beforeIndex: 0, ...o,
});

describe("marker labels", () => {
  it("say what came from Drive, from which PC and when", () => {
    expect(markerLabel(mk("a.nqv"), NOW)).toBe("Updated from Drive · from LAPTOP · 2 hours ago");
    expect(markerLabel(mk("a.nqv", { kind: "added" }), NOW)).toBe("New from Drive · from LAPTOP · 2 hours ago");
    expect(markerLabel(mk("a.nqv", { kind: "restored", fromDevice: "" }), NOW)).toBe("Restored from Drive · 2 hours ago");
  });
});

describe("marker index", () => {
  const markers = [mk("Work/a.nqv"), mk("Work/Deep/b.nqv"), mk("gone.nqv", { deleted: true }), mk("bin.nqv", { trashed: true })];
  it("indexes shown entries by lower-cased rel and counts them inside folders", () => {
    const idx = markerIndex(markers);
    expect([...idx.keys()].sort()).toEqual(["work/a.nqv", "work/deep/b.nqv"]);
    expect(markedInside(idx, "Work")).toBe(2);
    expect(markedInside(idx, "Work/Deep")).toBe(1);
    expect(markedInside(idx, "Wor")).toBe(0);
  });
  it("the review list leaves out deleted entries, newest first", () => {
    const list = reviewList([mk("old.nqv", { at: 1 }), mk("new.nqv", { at: 5 }), mk("x.nqv", { deleted: true })]);
    expect(list.map((m) => m.rel)).toEqual(["new.nqv", "old.nqv"]);
  });
  it("finds the rel of a full path, longest match first", () => {
    expect(relOfPath(["a.nqv", "Work/a.nqv"], "C:\\Vault\\Work\\a.nqv")).toBe("work/a.nqv");
    expect(relOfPath(["a.nqv", "Work/a.nqv"], "C:/Vault/a.nqv")).toBe("a.nqv");
    expect(relOfPath(["a.nqv"], "C:/Vault/ba.nqv")).toBeNull();
  });
});

describe("Review action", () => {
  it("is offered only when the sync brought changes, and opens the Recently synced view", () => {
    expect(reviewActions({ added: 0, updated: 0, removed: 0, conflicts: [] })).toEqual([]);
    const [a] = reviewActions({ added: 1, updated: 0, removed: 0, conflicts: [] });
    expect(a.label).toBe("Review");
    const before = useSyncMarkersStore.getState().reviewRequest;
    a.onClick();
    expect(useSyncMarkersStore.getState().reviewOpen).toBe(true);
    expect(useSyncMarkersStore.getState().reviewRequest).toBe(before + 1);
  });
});

describe("markers store", () => {
  beforeEach(() => {
    invoke.mockReset();
    useSyncMarkersStore.setState({ markers: [], opened: {}, loaded: false, reviewOpen: false });
  });

  it("opening an entry clears its marker but keeps it for the entry banner", async () => {
    invoke.mockImplementation(async (cmd: string) => (cmd === "sync_markers_list" ? [mk("Work/a.nqv"), mk("b.nqv")] : undefined));
    await useSyncMarkersStore.getState().refresh();
    expect(useSyncMarkersStore.getState().markers).toHaveLength(2);
    useSyncMarkersStore.getState().markOpened("work/A.nqv");
    expect(invoke).toHaveBeenCalledWith("sync_marker_clear", { id: "id-Work/a.nqv" });
    const s = useSyncMarkersStore.getState();
    expect(s.markers.map((m) => m.rel)).toEqual(["b.nqv"]);
    expect(s.opened["work/a.nqv"]?.id).toBe("id-Work/a.nqv");
    s.dismissBanner("Work/a.nqv");
    expect(useSyncMarkersStore.getState().opened).toEqual({});
  });

  it("Mark all as seen clears every marker", async () => {
    useSyncMarkersStore.setState({ markers: [mk("a.nqv"), mk("b.nqv")] });
    invoke.mockImplementation(async (cmd: string) => (cmd === "sync_markers_list" ? [] : undefined));
    await useSyncMarkersStore.getState().clearAll();
    expect(invoke).toHaveBeenCalledWith("sync_markers_clear_all", undefined);
    expect(useSyncMarkersStore.getState().markers).toEqual([]);
  });

  it("a failing list (locked vault) shows nothing", async () => {
    invoke.mockRejectedValue("VAULT_LOCKED");
    await useSyncMarkersStore.getState().refresh();
    expect(useSyncMarkersStore.getState()).toMatchObject({ markers: [], loaded: true });
  });
});
