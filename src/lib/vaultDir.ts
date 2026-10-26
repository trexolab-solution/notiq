import { documentDir, homeDir, join } from "@tauri-apps/api/path";
import { exists, mkdir } from "@tauri-apps/plugin-fs";
import { open } from "@tauri-apps/plugin-dialog";
import { getVaultDir, setVaultDir, clearVaultDir } from "./vaultPrefs";

export const VAULT_DIR_EVENT = "vault:dir-changed";
const changed = () => window.dispatchEvent(new Event(VAULT_DIR_EVENT));

/** The chosen storage folder, or the default `Documents/Notiq Vault`. */
export async function resolveVaultDir(): Promise<string> {
  return getVaultDir() ?? (await join(await documentDir(), "Notiq Vault"));
}

async function mk(dir: string): Promise<string> {
  if (!(await exists(dir))) await mkdir(dir, { recursive: true });
  return dir;
}

/** Creates the storage folder if needed. Default falls back to ~/Notiq Vault if Documents isn't writable. */
export async function ensureVaultDir(): Promise<string> {
  const dir = await resolveVaultDir();
  try {
    return await mk(dir);
  } catch (e) {
    if (getVaultDir()) throw e;
    return mk(await join(await homeDir(), "Notiq Vault"));
  }
}

export async function pickVaultDir(): Promise<string | null> {
  const sel = await open({ directory: true, multiple: false, title: "Choose vault storage folder" });
  if (typeof sel !== "string") return null;
  setVaultDir(sel);
  changed();
  return sel;
}

export function resetVaultDir() {
  clearVaultDir();
  changed();
}
