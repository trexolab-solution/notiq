import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { toast } from "./toast";

/** A running WebDAV share: where to point the phone's WebDAV app, and how to sign in. */
export interface ShareInfo { url: string; username: string; password: string; folder: string; /** A phone may add new files and folders. */ upload: boolean; /** A phone may also rename, move, copy and delete. */ manage: boolean; /** The connection is encrypted (HTTPS, self-signed certificate). */ https: boolean; /** SHA-256 of the certificate (AB:CD:…), to compare on the phone. */ fingerprint: string | null }

/** Empty user name / password = the defaults (`notiq`, and a random password). */
export const webdavStart = (folder: string, username = "", password = "", upload = true, manage = false, https = false) =>
  invoke<ShareInfo>("webdav_start", { folder, username, password, upload, manage, https });
export const webdavStop = () => invoke<void>("webdav_stop");
export const webdavStatus = () => invoke<ShareInfo | null>("webdav_status");

/** The folder shared last time, so turning sharing on again is one click. */
const FOLDER_KEY = "notiq.webdavFolder";
export const getShareFolder = (): string => { try { return localStorage.getItem(FOLDER_KEY) ?? ""; } catch { return ""; } };
export const setShareFolder = (p: string) => { try { localStorage.setItem(FOLDER_KEY, p); } catch { /* private mode: not remembered */ } };

/** The user name chosen last time. The password is never written to disk: it lives in memory until the app closes. */
const USER_KEY = "notiq.webdavUser";
const getShareUser = (): string => { try { return localStorage.getItem(USER_KEY) ?? ""; } catch { return ""; } };
const setShareUser = (u: string) => { try { if (u) localStorage.setItem(USER_KEY, u); else localStorage.removeItem(USER_KEY); } catch { /* not remembered */ } };

/** The address with the sign-in inside it: a scan then needs no typing (the phone does not ask for the password). */
export const shareLink = (i: ShareInfo) => i.url.replace("://", `://${encodeURIComponent(i.username)}:${encodeURIComponent(i.password)}@`);

/** Whether the QR code carries the password. Off by default: anyone who sees the screen could scan it. */
const QR_LOGIN_KEY = "notiq.webdavQrLogin";
export const getQrWithLogin = (): boolean => { try { return localStorage.getItem(QR_LOGIN_KEY) === "1"; } catch { return false; } };
export const setQrWithLogin = (on: boolean) => { try { localStorage.setItem(QR_LOGIN_KEY, on ? "1" : "0"); } catch { /* not remembered */ } };

/** Whether a phone may upload (add new files and folders). On unless the user turned it off. */
const UPLOAD_KEY = "notiq.webdavUpload";
const getShareUpload = (): boolean => { try { return localStorage.getItem(UPLOAD_KEY) !== "0"; } catch { return true; } };
const setShareUpload = (on: boolean) => { try { localStorage.setItem(UPLOAD_KEY, on ? "1" : "0"); } catch { /* not remembered */ } };

/** Whether a phone may also rename, move, copy and delete. Off unless the user turned it on: deleting can't be undone. */
const MANAGE_KEY = "notiq.webdavManage";
const getShareManage = (): boolean => { try { return localStorage.getItem(MANAGE_KEY) === "1"; } catch { return false; } };
const setShareManage = (on: boolean) => { try { localStorage.setItem(MANAGE_KEY, on ? "1" : "0"); } catch { /* not remembered */ } };

/** Whether sharing uses HTTPS with a self-signed certificate. Off by default: some WebDAV apps refuse such certificates. */
const HTTPS_KEY = "notiq.webdavHttps";
const getShareHttps = (): boolean => { try { return localStorage.getItem(HTTPS_KEY) === "1"; } catch { return false; } };
const setShareHttps = (on: boolean) => { try { localStorage.setItem(HTTPS_KEY, on ? "1" : "0"); } catch { /* not remembered */ } };

/** What a phone may do, in words (managing includes uploading). */
export const shareMode = (upload: boolean, manage: boolean) => (manage ? "Full access" : upload ? "Uploads allowed" : "Read-only");

export const DEFAULT_SHARE_USER = "notiq";
export const MIN_SHARE_PASSWORD = 8;

/** What is wrong with a typed login, or "" when it is fine. An empty password is fine: a random one is made. */
export function loginProblem(user: string, pass: string): string {
  const u = user.trim();
  if (u.length > 32 || u.includes(":")) return "The user name can have up to 32 characters and no colon (:).";
  if (pass && pass.length < MIN_SHARE_PASSWORD) return `The password needs at least ${MIN_SHARE_PASSWORD} characters.`;
  if (pass.length > 64) return "The password can have up to 64 characters.";
  return "";
}

/** A new random password (12 letters and digits, none easy to mix up). */
export function generateSharePassword(): string {
  const chars = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint32Array(12));
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

export const shareErrorMessage = (e: unknown) => (typeof e === "string" ? e : e instanceof Error ? e.message : "Couldn't change sharing.");

interface ShareStore {
  /** What is being shared right now (null = off). */
  info: ShareInfo | null;
  busy: boolean;
  /** The sign-in the next start uses ("" = the default / a random password). Kept in memory; only the user name is saved. */
  user: string;
  pass: string;
  /** Whether the next start allows uploads from the phone. */
  upload: boolean;
  /** Whether the next start also allows renaming, moving, copying and deleting. */
  manage: boolean;
  /** Whether the next start encrypts the connection (HTTPS). */
  https: boolean;
  /** Asks the app what is being shared (the server lives in the backend, not in this page). */
  refresh: () => Promise<void>;
  /** Remembers the sign-in for the next start (it does not touch a running share: see `restart`). */
  setLogin: (user: string, pass: string) => void;
  setUpload: (on: boolean) => void;
  setManage: (on: boolean) => void;
  setHttps: (on: boolean) => void;
  start: (folder: string) => Promise<void>;
  stop: () => Promise<void>;
  /** Stops and starts again with the stored sign-in, so every phone has to sign in anew. */
  restart: (folder: string) => Promise<void>;
}

/** The share's state, shared by the settings page, the command palette and the tray menu. */
export const useShareStore = create<ShareStore>((set, get) => ({
  info: null,
  busy: false,
  user: getShareUser(),
  pass: "",
  upload: getShareUpload(),
  manage: getShareManage(),
  https: getShareHttps(),
  async refresh() { try { set({ info: await webdavStatus() }); } catch { /* not the desktop app */ } },
  setLogin(user, pass) { setShareUser(user.trim()); set({ user: user.trim(), pass }); },
  setUpload(on) { setShareUpload(on); set({ upload: on }); },
  setManage(on) { setShareManage(on); set({ manage: on }); },
  setHttps(on) { setShareHttps(on); set({ https: on }); },
  async start(folder) {
    set({ busy: true });
    try { const { user, pass, upload, manage, https } = get(); set({ info: await webdavStart(folder, user, pass, upload, manage, https) }); } finally { set({ busy: false }); }
  },
  async stop() {
    set({ busy: true });
    try { await webdavStop(); set({ info: null }); } finally { set({ busy: false }); }
  },
  async restart(folder) {
    set({ busy: true });
    try {
      await webdavStop(); set({ info: null });
      const { user, pass, upload, manage, https } = get();
      set({ info: await webdavStart(folder, user, pass, upload, manage, https) });
    } finally { set({ busy: false }); }
  },
}));

/**
 * One-step on / off from anywhere (palette, tray): stops a running share; otherwise starts the last folder and opens
 * the settings where the QR code is. With no folder yet it opens the settings to pick one.
 */
export async function quickToggleShare(openSettings: (section: "share", settingId: string) => void) {
  const s = useShareStore.getState();
  await s.refresh();
  try {
    if (useShareStore.getState().info) { await s.stop(); toast.success("WebDAV sharing is off."); return; }
    const folder = getShareFolder();
    if (!folder) { toast.info("Pick a folder to share first."); openSettings("share", "share.folder"); return; }
    await s.start(folder);
    toast.success("WebDAV sharing is on. Scan the QR code.");
    openSettings("share", "share.enabled");
  } catch (e) { toast.error(shareErrorMessage(e)); }
}
