import { exists, mkdir } from "@tauri-apps/plugin-fs";
import { ask, open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { getVaultDir, setVaultDir, clearVaultDir } from "./vaultPrefs";
import { cloudFolderName } from "./cloudFolders";

export const VAULT_DIR_EVENT = "vault:dir-changed";
const changed = () => window.dispatchEvent(new Event(VAULT_DIR_EVENT));

/**
 * The chosen storage folder, or the default: the app-data folder next to the key file
 * (the backend decides, so a vault an older version made in Documents keeps working).
 */
export async function resolveVaultDir(): Promise<string> {
  return getVaultDir() ?? (await invoke<string>("vault_default_dir"));
}

async function mk(dir: string): Promise<string> {
  if (!(await exists(dir))) await mkdir(dir, { recursive: true });
  return dir;
}

/** Makes sure the storage folder exists and tells the backend where it is. */
export async function ensureVaultDir(): Promise<string> {
  const custom = getVaultDir();
  // The default folder is created by the backend; a folder the user picked is created here if it vanished.
  const out = custom ? await mk(custom) : await resolveVaultDir();
  await invoke<void>("vault_set_root", { root: out });
  return out;
}

export async function pickVaultDir(): Promise<string | null> {
  const sel = await open({ directory: true, multiple: false, title: "Choose vault storage folder" });
  if (typeof sel !== "string") return null;
  const cloud = cloudFolderName(sel);
  if (cloud) {
    const ok = await ask(
      `This folder is synced by ${cloud}, so your encrypted vault file would be copied to their servers and could get conflicting copies if you use it on two computers.

Use it anyway?`,
      { title: "Cloud-synced folder", kind: "warning", okLabel: "Use anyway", cancelLabel: "Choose another" },
    );
    if (!ok) return null;
  }
  setVaultDir(sel);
  changed();
  return sel;
}

export function resetVaultDir() {
  clearVaultDir();
  changed();
}
