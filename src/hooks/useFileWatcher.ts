import { useEffect, useRef } from "react";
import { stat, readTextFile } from "@tauri-apps/plugin-fs";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useAppStore } from "../store";
import { isTauri } from "../lib/tauriWindow";
import { toast } from "../lib/toast";

// How often to poll open file-backed tabs for external changes. Notepad++ uses
// the same poll-based approach; ~1.2 s feels instant without burning CPU. We
// also re-check immediately whenever the window regains focus (alt-tab back),
// which is when an external edit is most likely to have happened.
const POLL_MS = 1200;

/** A signature that changes whenever a file is modified on disk. */
function sig(mtimeMs: number, size: number): string {
  return `${mtimeMs}:${size}`;
}

/**
 * Watches every open note that is backed by a file on disk and auto-reloads it
 * when another program changes the file (git pull, external editor, etc.).
 *
 *  - Clean tab  → content is silently replaced with the new disk content.
 *  - Dirty tab  → unsaved edits are preserved; the user is warned once so they
 *                 can decide whether to save (overwrite) or close-and-reopen.
 *
 * The first time a tab is seen we record a baseline without reloading, so
 * opening a file never looks like an external change. Our own saves are a
 * no-op too: the disk content equals the tab content, so nothing is reloaded.
 */
export function useFileWatcher() {
  // tabId → last acknowledged on-disk signature.
  const baselines = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    if (!isTauri) return;

    let cancelled = false;
    let busy = false; // guards against the poll and focus-check overlapping
    let timer: ReturnType<typeof setTimeout> | null = null;

    const checkOnce = async () => {
      if (busy || cancelled) return;
      busy = true;
      try {
        await scan();
      } finally {
        busy = false;
      }
    };

    const scan = async () => {
      const tabs = useAppStore.getState().tabs;
      const liveIds = new Set<string>();

      for (const tab of tabs) {
        if (tab.kind !== "note" || !tab.filePath) continue;
        liveIds.add(tab.id);
        const path = tab.filePath;

        let info: Awaited<ReturnType<typeof stat>>;
        try {
          info = await stat(path);
        } catch {
          // File deleted/renamed/unreadable — skip; don't nag.
          continue;
        }
        if (cancelled) return;

        const current = sig(info.mtime?.getTime() ?? 0, info.size);
        const base = baselines.current.get(tab.id);

        if (base === undefined) {
          // First sighting — establish baseline, never reload.
          baselines.current.set(tab.id, current);
          continue;
        }
        if (base === current) continue; // unchanged on disk

        // Changed on disk — acknowledge the new signature up front so we report
        // each distinct external change at most once.
        baselines.current.set(tab.id, current);

        let disk: string;
        try {
          disk = await readTextFile(path);
        } catch {
          continue;
        }
        if (cancelled) return;

        // Re-fetch the tab: it may have changed/closed during the awaits above.
        const fresh = useAppStore.getState().tabs.find((t) => t.id === tab.id);
        if (!fresh) continue;
        if (disk === fresh.content) continue; // e.g. our own save — nothing to do

        if (fresh.isDirty) {
          toast.warning(`"${fresh.title}" changed on disk — your unsaved edits were kept`);
        } else {
          useAppStore.getState().reloadTabFromDisk(tab.id, disk);
          toast.info(`Reloaded "${fresh.title}" (changed on disk)`);
        }
      }

      // Drop baselines for tabs that no longer exist so closing+reopening a file
      // re-establishes a fresh baseline instead of reusing a stale one.
      for (const id of baselines.current.keys()) {
        if (!liveIds.has(id)) baselines.current.delete(id);
      }
    };

    const loop = async () => {
      await checkOnce();
      if (!cancelled) timer = setTimeout(loop, POLL_MS);
    };
    loop();

    // Check immediately when the window regains focus.
    let unlistenFocus: (() => void) | undefined;
    getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => { if (focused) checkOnce(); })
      .then((fn) => { unlistenFocus = fn; })
      .catch(() => {});

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      unlistenFocus?.();
    };
  }, []);
}
