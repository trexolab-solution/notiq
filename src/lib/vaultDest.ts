import { create } from "zustand";
import { readDir, mkdir } from "@tauri-apps/plugin-fs";
import { ensureVaultDir } from "./vaultDir";

/** Pending "where should this locked note go?" request (one at a time). */
interface DestState { req: { name: string; resolve: (path: string | null) => void } | null }
export const useVaultDestStore = create<DestState>(() => ({ req: null }));

/**
 * Asks the user for a folder (inside the vault storage folder) and file name.
 * Resolves the full `.nqv` path, or null if cancelled.
 */
export function pickVaultDestination(name: string): Promise<string | null> {
  return new Promise((resolve) => {
    useVaultDestStore.getState().req?.resolve(null);
    useVaultDestStore.setState({ req: { name, resolve } });
  });
}

const KEY_LAST = "pref:vaultLastFolder";
export function getLastFolder(): string {
  try { return localStorage.getItem(KEY_LAST) ?? ""; } catch { return ""; }
}
export function setLastFolder(f: string) {
  try { localStorage.setItem(KEY_LAST, f); } catch { /* unavailable */ }
}

/** Strip characters that are invalid in file/folder names. */
export const safeName = (s: string) =>
  s.replace(/[\\/:*?"<>|]/g, "-").replace(/^[.\s]+|[\s.]+$/g, "").slice(0, 80);

export const joinPath = (...parts: string[]) =>
  parts.filter(Boolean).map((p, i) => (i === 0 ? p.replace(/\\/g, "/").replace(/\/+$/, "") : p.replace(/^\/+|\/+$/g, ""))).join("/");

/** Sub-folders directly inside the vault storage folder. */
export async function listVaultFolders(): Promise<{ root: string; folders: string[] }> {
  const root = await ensureVaultDir();
  const entries = await readDir(root);
  const folders = entries.filter((e) => e.isDirectory && !e.name.startsWith(".")).map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
  return { root, folders };
}

export async function createVaultFolder(name: string): Promise<string> {
  const f = safeName(name);
  if (!f) throw new Error("Enter a folder name");
  const root = await ensureVaultDir();
  await mkdir(joinPath(root, f), { recursive: true });
  return f;
}
