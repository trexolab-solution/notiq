import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { toast } from "./toast";

/** A running "Share files to phone" server: where to point the phone's WebDAV app, and how to sign in. */
export interface ShareInfo { url: string; username: string; password: string; folder: string }

/** Empty user name / password = the defaults (`notiq`, and a random password). */
export const webdavStart = (folder: string, username = "", password = "") => invoke<ShareInfo>("webdav_start", { folder, username, password });
export const webdavStop = () => invoke<void>("webdav_stop");
export const webdavStatus = () => invoke<ShareInfo | null>("webdav_status");

/** The folder shared last time, so turning sharing on again is one click. */
const FOLDER_KEY = "notiq.webdavFolder";
export const getShareFolder = (): string => { try { return localStorage.getItem(FOLDER_KEY) ?? ""; } catch { return ""; } };
export const setShareFolder = (p: string) => { try { localStorage.setItem(FOLDER_KEY, p); } catch { /* private mode: not remembered */ } };

/** The user name typed last time. The password is not kept: it lives only while sharing runs. */
const USER_KEY = "notiq.webdavUser";
export const getShareUser = (): string => { try { return localStorage.getItem(USER_KEY) ?? ""; } catch { return ""; } };
export const setShareUser = (u: string) => { try { localStorage.setItem(USER_KEY, u); } catch { /* not remembered */ } };

/** The address with the sign-in inside it: what the QR code holds, so a scan needs no typing. */
export const shareLink = (i: ShareInfo) => i.url.replace("://", `://${encodeURIComponent(i.username)}:${encodeURIComponent(i.password)}@`);

export const shareErrorMessage = (e: unknown) => (typeof e === "string" ? e : e instanceof Error ? e.message : "Couldn't change sharing.");

interface ShareStore {
  info: ShareInfo | null;
  busy: boolean;
  /** Asks the app what is being shared (the server lives in the backend, not in this page). */
  refresh: () => Promise<void>;
  start: (folder: string, username?: string, password?: string) => Promise<void>;
  stop: () => Promise<void>;
}

/** The share's state, shared by the settings page, the command palette and the tray menu. */
export const useShareStore = create<ShareStore>((set) => ({
  info: null,
  busy: false,
  async refresh() { try { set({ info: await webdavStatus() }); } catch { /* not the desktop app */ } },
  async start(folder, username, password) {
    set({ busy: true });
    try { set({ info: await webdavStart(folder, username, password) }); } finally { set({ busy: false }); }
  },
  async stop() {
    set({ busy: true });
    try { await webdavStop(); set({ info: null }); } finally { set({ busy: false }); }
  },
}));

/**
 * One-step on / off from anywhere (palette, tray): stops a running share; otherwise starts the last folder and opens
 * the settings where the QR code is. With no folder yet it opens the settings to pick one.
 */
export async function quickToggleShare(openSettings: (section: "vault", settingId: string) => void) {
  const s = useShareStore.getState();
  await s.refresh();
  try {
    if (useShareStore.getState().info) { await s.stop(); toast.success("Sharing to phone is off."); return; }
    const folder = getShareFolder();
    if (!folder) { toast.info("Pick a folder to share first."); openSettings("vault", "vault.share.folder"); return; }
    await s.start(folder, getShareUser());
    toast.success("Sharing to phone is on. Scan the QR code.");
    openSettings("vault", "vault.share.enabled");
  } catch (e) { toast.error(shareErrorMessage(e)); }
}
