/**
 * Keeps a server overview connected while its form is not on screen. Switching to another tab unmounts the form;
 * the open session waits here and the form takes it back, so returning doesn't sign in again. A parked session
 * reads the server now and then (the backend closes one that goes unread), and is closed when its tab closes or its
 * entry changes, when the vault locks, and when Notiq is hidden to the tray.
 */
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "../store";
import { useVaultStore } from "../store/vaultStore";
import { sftpErrorMessage } from "./sftp";
import { OVERVIEW_BUSY, overviewClose, overviewPoll, type ServerReading } from "./serverOverview";

/** How often a session nobody is looking at is read. The backend closes one after 2 minutes without a read. */
export const KEEPALIVE_MS = 45_000;

export interface ParkedOverview {
  sid: number;
  /** The entry it signed in with, as it was: any change to it ends the session. */
  path: string;
  content: string;
  reading: ServerReading | null;
  cpu: number[];
  mem: number[];
  updated: Date | null;
}

const parked = new Map<string, { session: ParkedOverview; timer: ReturnType<typeof setInterval> }>();
let watching = false;

/** Takes the session out without closing it. */
function release(tabId: string): ParkedOverview | null {
  const e = parked.get(tabId);
  if (!e) return null;
  clearInterval(e.timer);
  parked.delete(tabId);
  return e.session;
}

function drop(tabId: string): void {
  const s = release(tabId);
  if (s) void overviewClose(s.sid).catch(() => {});
}

export function closeParkedOverviews(): void {
  for (const tabId of [...parked.keys()]) drop(tabId);
}

type TabState = { id: string; filePath?: string; content: string; isDirty?: boolean; vaultLocked?: boolean };
const stillValid = (t: TabState | undefined, s: Pick<ParkedOverview, "path" | "content">) =>
  !!t && t.filePath === s.path && t.content === s.content && !t.isDirty && !t.vaultLocked;

function watch(): void {
  if (watching) return;
  watching = true;
  useAppStore.subscribe((state) => {
    for (const [tabId, e] of parked) if (!stillValid(state.tabs.find((t) => t.id === tabId), e.session)) drop(tabId);
  });
  useVaultStore.subscribe((state) => { if (!state.unlocked) closeParkedOverviews(); });
  listen("vault-window-hidden", closeParkedOverviews).catch(() => {});
}

/** Parks an open session for the tab. It is closed instead when the tab or the vault no longer allows it. */
export function parkOverview(tabId: string, session: ParkedOverview): void {
  drop(tabId);
  const tab = useAppStore.getState().tabs.find((t) => t.id === tabId);
  if (!useVaultStore.getState().unlocked || !stillValid(tab, session)) {
    void overviewClose(session.sid).catch(() => {});
    return;
  }
  watch();
  const timer = setInterval(() => {
    overviewPoll(session.sid).then(
      (r) => {
        if (!r.supported) drop(tabId);
        else { session.reading = r; session.updated = new Date(); }
      },
      (e) => { if (sftpErrorMessage(e) !== OVERVIEW_BUSY && parked.get(tabId)?.session === session) drop(tabId); },
    );
  }, KEEPALIVE_MS);
  parked.set(tabId, { session, timer });
}

/** The tab's parked session, if it is still for the same entry. */
export function takeOverview(tabId: string, path: string | undefined, content: string): ParkedOverview | null {
  const e = parked.get(tabId);
  if (!e) return null;
  if (e.session.path !== path || e.session.content !== content) { drop(tabId); return null; }
  return release(tabId);
}
