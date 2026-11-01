import { vaultList } from "./vault";
import { ensureVaultDir } from "./vaultDir";
import { childNames, displayName, parentRel, renamedRel, toFull, toRel } from "./vaultTree";
import { planEntryName, sanitizeEntryName } from "./entryName";

export interface EntryRenamePlan {
  /** The item name the entry ends up with (also written back as its title). */
  name: string;
  /** Full virtual path for that name; equal to the input path when no rename is needed. */
  to: string;
}

/**
 * Works out where a structured entry at full path `path` should live once saved
 * with Name `title`: same folder, item name from the Name (see `planEntryName`).
 * Only lists the vault when the name actually differs. Null when `path` isn't
 * inside the vault folder (nothing to rename).
 */
export async function planEntryRename(path: string, title: string): Promise<EntryRenamePlan | null> {
  const root = (await ensureVaultDir()).replace(/\\/g, "/").replace(/\/+$/, "");
  const rel = toRel(root, path);
  if (!rel) return null;
  const current = displayName(rel);
  const wanted = sanitizeEntryName(title);
  if (!wanted || wanted === current) return { name: current, to: path };
  const name = planEntryName(title, current, childNames(await vaultList(), parentRel(rel)));
  return { name, to: name === current ? path : toFull(root, renamedRel(rel, name, false)) };
}
