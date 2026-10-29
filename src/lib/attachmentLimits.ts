import {
  vaultAttachList, vaultList, VAULT_ATTACH_MAX_BYTES, VAULT_ATTACH_MAX_PER_NOTE, VAULT_ATTACH_MAX_TOTAL,
} from "./vault";
import { toFull } from "./vaultTree";

/**
 * Bytes used by attachments across the whole vault. There's no single backend call for it, so this
 * lists the attachments of every entry that has any (metadata only — never file data).
 */
export async function vaultAttachmentsUsed(root: string): Promise<number> {
  const items = (await vaultList()).filter((i) => !i.dir && i.attachments > 0);
  let total = 0;
  for (const i of items) {
    for (const a of await vaultAttachList(toFull(root, i.rel))) total += a.size;
  }
  return total;
}

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1).replace(/\.0$/, "")} MB`;

/**
 * Friendly reason a file can't be attached, or null when it fits. Mirrors the checks in
 * src-tauri/src/vault_db.rs (`attach_add`) so the user hears about it before the file is read.
 * `vaultUsed` is the size of every attachment in the whole vault (the 25 MB limit is vault-wide).
 */
export function attachmentLimitError(size: number, entryCount: number, vaultUsed: number): string | null {
  if (entryCount >= VAULT_ATTACH_MAX_PER_NOTE) return `An entry can have at most ${VAULT_ATTACH_MAX_PER_NOTE} attachments`;
  if (size > VAULT_ATTACH_MAX_BYTES) return `That file is ${mb(size)} — attachments can be at most ${mb(VAULT_ATTACH_MAX_BYTES)} each`;
  if (vaultUsed + size > VAULT_ATTACH_MAX_TOTAL) {
    const left = Math.max(0, VAULT_ATTACH_MAX_TOTAL - vaultUsed);
    return `Not enough attachment space: the vault holds at most ${mb(VAULT_ATTACH_MAX_TOTAL)} of attachments and ${mb(left)} is left`;
  }
  return null;
}

/** Last path segment of a Windows or POSIX path. */
export const fileNameOf = (p: string) => p.split(/[\\/]/).pop() || "attachment";
