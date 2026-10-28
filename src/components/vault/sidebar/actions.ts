import { useAppStore } from "../../../store";
import { useVaultStore } from "../../../store/vaultStore";
import { readFileEntry } from "../../../lib/fileOps";
import {
  vaultDuplicate, vaultEmptyTrash, vaultErrorMessage, vaultMkdir, vaultPurge, vaultRename, vaultRestore,
  vaultSetStarred, vaultSetTags, vaultTrash, type VaultItem,
} from "../../../lib/vault";
import { createVaultEntryAt, type NewEntryKind } from "../../../lib/vaultCreate";
import {
  canMoveTo, displayName, joinRel, movedRel, nameError, nameTaken, normalizeTags, parentRel, renamedRel, toFull, toRel,
} from "../../../lib/vaultTree";
import { toast } from "../../../lib/toast";

/**
 * Sidebar operations. Each validates against the current list, calls the
 * backend with full virtual paths, keeps open tabs consistent, and reports
 * failures as a toast. They resolve the resulting rel (or true) on success,
 * null/false on failure, so the caller can update selection.
 */

const fail = (e: unknown) => { toast.error(vaultErrorMessage(e)); };

export async function openEntry(root: string, rel: string) {
  try {
    useAppStore.getState().openFilesAsTabs([await readFileEntry(toFull(root, rel))]);
    if (await useVaultStore.getState().ensureUnlocked()) await useAppStore.getState().unlockVaultTabs();
  } catch (e) { fail(e); }
}

/** Validates a name for `folder`; toasts and returns false when it can't be used. */
function checkName(items: VaultItem[], folder: string, name: string, except?: string): boolean {
  const err = nameError(name);
  if (err) { toast.error(err); return false; }
  if (nameTaken(items, folder, name, except)) {
    toast.error(`"${name.trim()}" already exists ${folder ? `in ${displayName(folder)}` : "here"}`);
    return false;
  }
  return true;
}

export async function renameEntry(root: string, items: VaultItem[], rel: string, dir: boolean, newName: string):
  Promise<string | null> {
  const name = newName.trim();
  if (!name || name === displayName(rel)) return rel;
  if (!checkName(items, parentRel(rel), name, rel)) return null;
  const to = renamedRel(rel, name, dir);
  try {
    await vaultRename(toFull(root, rel), toFull(root, to));
    useAppStore.getState().remapVaultTabs(toFull(root, rel), toFull(root, to));
    return to;
  } catch (e) { fail(e); return null; }
}

export async function moveEntry(root: string, items: VaultItem[], rel: string, destFolder: string):
  Promise<string | null> {
  if (!canMoveTo(rel, destFolder)) return null;
  const name = displayName(rel);
  if (nameTaken(items, destFolder, name)) {
    toast.error(`"${name}" already exists in ${destFolder ? displayName(destFolder) : "the vault root"}`);
    return null;
  }
  const to = movedRel(rel, destFolder);
  try {
    await vaultRename(toFull(root, rel), toFull(root, to));
    useAppStore.getState().remapVaultTabs(toFull(root, rel), toFull(root, to));
    return to;
  } catch (e) { fail(e); return null; }
}

export async function duplicateEntry(root: string, rel: string): Promise<string | null> {
  try {
    const full = await vaultDuplicate(toFull(root, rel));
    return toRel(root, full) ?? null;
  } catch (e) { fail(e); return null; }
}

export async function setStarred(root: string, rel: string, starred: boolean) {
  try { await vaultSetStarred(toFull(root, rel), starred); } catch (e) { fail(e); }
}

export async function setTags(root: string, rel: string, tags: string[]): Promise<boolean> {
  try { await vaultSetTags(toFull(root, rel), normalizeTags(tags)); return true; } catch (e) { fail(e); return false; }
}

export async function trashEntry(root: string, rel: string, dir: boolean): Promise<boolean> {
  try {
    await vaultTrash(toFull(root, rel));
    useAppStore.getState().closeVaultTabs(toFull(root, rel));
    toast.info(`Moved "${displayName(rel)}"${dir ? " and its contents" : ""} to Trash`);
    return true;
  } catch (e) { fail(e); return false; }
}

export async function restoreEntry(root: string, rel: string) {
  try {
    await vaultRestore(toFull(root, rel));
    toast.success(`Restored "${displayName(rel)}"`);
  } catch (e) { fail(e); }
}

export async function purgeEntry(root: string, rel: string) {
  try { await vaultPurge(toFull(root, rel)); } catch (e) { fail(e); }
}

export async function emptyTrash() {
  try { await vaultEmptyTrash(); toast.info("Trash emptied"); } catch (e) { fail(e); }
}

export async function createFolder(root: string, items: VaultItem[], parent: string, name: string):
  Promise<string | null> {
  if (!checkName(items, parent, name)) return null;
  const rel = joinRel(parent, name.trim());
  try { await vaultMkdir(toFull(root, rel)); return rel; } catch (e) { fail(e); return null; }
}

export async function createEntry(root: string, items: VaultItem[], kind: NewEntryKind, parent: string, name: string):
  Promise<string | null> {
  if (!checkName(items, parent, name)) return null;
  const rel = joinRel(parent, `${name.trim()}.nqv`);
  return (await createVaultEntryAt(kind, toFull(root, rel))) ? rel : null;
}
