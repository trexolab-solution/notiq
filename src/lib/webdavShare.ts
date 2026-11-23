import { invoke } from "@tauri-apps/api/core";

/** A running "Share files to phone" server: where to point the phone's WebDAV app, and how to sign in. */
export interface ShareInfo { url: string; username: string; password: string; folder: string }

export const webdavStart = (folder: string) => invoke<ShareInfo>("webdav_start", { folder });
export const webdavStop = () => invoke<void>("webdav_stop");
export const webdavStatus = () => invoke<ShareInfo | null>("webdav_status");

/** The folder shared last time, so turning sharing on again is one click. */
const FOLDER_KEY = "notiq.webdavFolder";
export const getShareFolder = (): string => { try { return localStorage.getItem(FOLDER_KEY) ?? ""; } catch { return ""; } };
export const setShareFolder = (p: string) => { try { localStorage.setItem(FOLDER_KEY, p); } catch { /* private mode: not remembered */ } };
