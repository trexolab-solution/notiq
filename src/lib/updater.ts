// In-app self-update (Tauri updater plugin). A small pub/sub singleton — modeled
// on `lib/ai/activity.ts` — so the topbar pill, the Settings → About controls,
// and the update dialog all read one shared state. The actual signed download +
// install + relaunch is handled by the Tauri updater/process plugins.

import { check, type Update, type DownloadEvent } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { isTauri } from "./tauriWindow";

export type UpdaterStatus =
  | "idle"        // nothing checked yet
  | "checking"    // querying the endpoint
  | "uptodate"    // checked, already on the latest version
  | "available"   // a newer version is available
  | "downloading" // download + install in progress
  | "ready"       // installed; about to relaunch
  | "error";      // last check/install failed

export interface UpdaterState {
  status: UpdaterStatus;
  version: string | null; // the available version (when status === "available")
  notes: string | null;   // release notes / body
  date: string | null;    // publish date string from the manifest
  progress: number;       // 0..1 during download
  error: string | null;
  dialogOpen: boolean;
}

type Listener = (s: UpdaterState) => void;

let state: UpdaterState = {
  status: "idle", version: null, notes: null, date: null,
  progress: 0, error: null, dialogOpen: false,
};

// The Update handle returned by check(); reused by install() after the user
// chooses to update (e.g. from the topbar pill, some time after the check).
let pending: Update | null = null;
const listeners = new Set<Listener>();

function set(patch: Partial<UpdaterState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l(state));
}

export const updater = {
  getState: (): UpdaterState => state,

  subscribe(l: Listener): () => void {
    listeners.add(l);
    return () => { listeners.delete(l); };
  },

  /**
   * Check the configured endpoint for a newer version. Safe to call anywhere —
   * it no-ops outside Tauri and while a check/download is already running.
   * `silent` (used by the startup check) keeps it from being noisy: callers can
   * inspect the resolved status instead of showing "up to date"/error toasts.
   */
  async check({ silent = false }: { silent?: boolean } = {}): Promise<UpdaterStatus> {
    void silent; // semantics live at the call site; kept for clarity/JSDoc
    if (!isTauri) return state.status;
    if (state.status === "checking" || state.status === "downloading") return state.status;
    set({ status: "checking", error: null });
    try {
      const update = await check();
      if (update) {
        pending = update;
        set({
          status: "available",
          version: update.version,
          notes: update.body ?? null,
          date: update.date ?? null,
        });
      } else {
        pending = null;
        set({ status: "uptodate" });
      }
    } catch (e) {
      set({ status: "error", error: mapUpdaterError(e) });
    }
    return state.status;
  },

  /** Download + install the pending update (with progress), then relaunch. */
  async install(): Promise<void> {
    if (!isTauri || !pending) return;
    if (state.status === "downloading") return;
    set({ status: "downloading", progress: 0, error: null });
    let total = 0;
    let downloaded = 0;
    try {
      await pending.downloadAndInstall((event: DownloadEvent) => {
        switch (event.event) {
          case "Started":
            total = event.data.contentLength ?? 0;
            break;
          case "Progress":
            downloaded += event.data.chunkLength ?? 0;
            set({ progress: total > 0 ? Math.min(1, downloaded / total) : 0 });
            break;
          case "Finished":
            set({ progress: 1 });
            break;
        }
      });
      set({ status: "ready" });
      await relaunch(); // boots into the freshly installed version
    } catch (e) {
      set({ status: "error", error: mapUpdaterError(e) });
    }
  },

  /** Relaunch into the installed update (used if the auto-relaunch was deferred). */
  async relaunchApp(): Promise<void> {
    if (isTauri) await relaunch();
  },

  openDialog() { set({ dialogOpen: true }); },
  closeDialog() { set({ dialogOpen: false }); },
};

/** Map a raw updater/transport error to a short, friendly message. */
export function mapUpdaterError(raw: unknown): string {
  const msg = raw instanceof Error ? raw.message : String(raw ?? "");
  if (/network|timeout|dns|connect|fetch|reqwest|sending request/i.test(msg))
    return "Couldn't reach the update server — check your internet connection.";
  if (/signature|verify|pubkey|public key|minisign/i.test(msg))
    return "Update signature couldn't be verified.";
  if (/40[0-9]|not found|no release/i.test(msg))
    return "No update is available right now.";
  return msg ? `Update error: ${msg}` : "Update check failed.";
}
