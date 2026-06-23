import { mkdir, readDir, remove, exists, copyFile } from "@tauri-apps/plugin-fs";
import { appDataDir } from "@tauri-apps/api/path";
import { writeBinaryFile } from "./fileOps";
import { dirname, joinPath } from "./pathUtils";
import type { Tab } from "../types";

const TEMP_BASE_NAME = "temp-attachments";
let tempBaseCache: string | null = null;

/** `<APPDATA>/notiq/temp-attachments` (forward-slash, no trailing slash). */
async function getTempBaseDir(): Promise<string> {
  if (tempBaseCache) return tempBaseCache;
  const base = (await appDataDir()).replace(/\\/g, "/").replace(/\/+$/, "");
  tempBaseCache = joinPath(base, TEMP_BASE_NAME);
  return tempBaseCache;
}

async function getTempDirForTab(tabId: string): Promise<string> {
  return joinPath(await getTempBaseDir(), tabId);
}

async function isTempPath(absPath: string): Promise<boolean> {
  const base = await getTempBaseDir();
  return absPath.replace(/\\/g, "/").startsWith(base + "/");
}

/** Find every `assets/...` path referenced by markdown image syntax in `content`. */
function referencedAssetPaths(content: string): Set<string> {
  const refs = new Set<string>();
  const re = /!\[[^\]]*\]\(([^)\s]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) refs.add(m[1]);
  return refs;
}

/** Writes bytes to `<temp-base>/<tabId>/<filename>`, creating dirs as needed. */
export async function writeTempImage(tabId: string, filename: string, bytes: Uint8Array): Promise<string> {
  const dir = await getTempDirForTab(tabId);
  await mkdir(dir, { recursive: true });
  const full = joinPath(dir, filename);
  await writeBinaryFile(full, bytes);
  return full;
}

/** Writes bytes to `<dirname(notePath)>/<relPath>`, creating dirs as needed. */
export async function writeAssetNextToNote(notePath: string, relPath: string, bytes: Uint8Array): Promise<string> {
  const noteDir = dirname(notePath.replace(/\\/g, "/"));
  const full = joinPath(noteDir, relPath);
  await mkdir(dirname(full), { recursive: true });
  await writeBinaryFile(full, bytes);
  return full;
}

/** Migrates temp-folder attachments referenced by `tab.content` to `<dirname(savePath)>/<relPath>`,
 *  copying bytes and deleting the temp originals. Orphaned temp entries (no markdown reference)
 *  are dropped from the returned map and removed by the per-tab folder cleanup at the end.
 *  Throws on copy failure so callers can abort the save. */
export async function migrateTempToSaveDir(tab: Tab, savePath: string): Promise<Record<string, string>> {
  const map = tab.attachments ?? {};
  const refs = referencedAssetPaths(tab.content);
  const next: Record<string, string> = {};
  const noteDir = dirname(savePath.replace(/\\/g, "/"));

  for (const [relPath, absPath] of Object.entries(map)) {
    if (!(await isTempPath(absPath))) {
      // Already lives next to a saved note — keep as-is (covers Save-As of an
      // already-saved note where some attachments were written direct).
      next[relPath] = absPath;
      continue;
    }
    if (!refs.has(relPath)) continue; // orphan — skip migration; folder removal below cleans it up

    const target = joinPath(noteDir, relPath);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(absPath, target);
    next[relPath] = target;
  }

  // Remove the (now mostly empty) per-tab temp dir — best-effort
  try { await remove(await getTempDirForTab(tab.id), { recursive: true }); } catch { /* ignore */ }

  return next;
}

/** Recursively delete `<temp-base>/<tabId>/`. Safe when the folder doesn't exist. */
export async function cleanupTabTemp(tabId: string): Promise<void> {
  const dir = await getTempDirForTab(tabId);
  try {
    if (await exists(dir)) await remove(dir, { recursive: true });
  } catch (e) {
    console.warn("attachments: cleanupTabTemp failed for", tabId, e);
  }
}

/** Lists `<temp-base>/`, deletes any subfolder whose name isn't in `activeTabIds`. */
export async function scanOrphanTempFolders(activeTabIds: Set<string>): Promise<void> {
  const base = await getTempBaseDir();
  if (!(await exists(base))) return;
  let entries;
  try { entries = await readDir(base); } catch { return; }
  for (const entry of entries) {
    if (!entry.isDirectory || !entry.name) continue;
    if (activeTabIds.has(entry.name)) continue;
    try {
      await remove(joinPath(base, entry.name), { recursive: true });
    } catch (e) {
      console.warn("attachments: failed to remove orphan temp folder", entry.name, e);
    }
  }
}
