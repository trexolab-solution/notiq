import { useAppStore } from "../store";
import { useVaultStore } from "../store/vaultStore";
import { ensureVaultDir, VAULT_DIR_EVENT } from "./vaultDir";
import { pickVaultDestination } from "./vaultDest";
import { vaultWriteFile, vaultErrorMessage } from "./vault";
import { readFileEntry } from "./fileOps";
import { emptyLogin, LOGIN_EXT, serializeLogin } from "./loginEntry";
import { emptySecret, SECRET_KINDS, serializeSecret } from "./secretEntry";
import { CODES_EXT, emptyCodes, serializeCodes } from "./recoveryCodes";
import { toast } from "./toast";

export type NewEntryKind = "note" | "login" | "ssh" | "secret" | "card" | "wifi" | "codes";

export const NEW_ENTRY_OPTIONS: { kind: NewEntryKind; label: string; hint: string }[] = [
  { kind: "note",   label: "Secure note",     hint: "Free text, Markdown" },
  { kind: "login",  label: "Login",           hint: "Site, username, password, 2-step code" },
  { kind: "ssh",    label: SECRET_KINDS.ssh.label,    hint: SECRET_KINDS.ssh.hint },
  { kind: "secret", label: SECRET_KINDS.secret.label, hint: SECRET_KINDS.secret.hint },
  { kind: "card",   label: SECRET_KINDS.card.label,   hint: SECRET_KINDS.card.hint },
  { kind: "wifi",   label: SECRET_KINDS.wifi.label,   hint: SECRET_KINDS.wifi.hint },
  { kind: "codes",  label: "Recovery codes",          hint: "Backup codes, mark each one used" },
];

const nameOf = (p: string) => (p.split(/[\\/]/).pop() ?? "").replace(/\.nqv$/i, "");

/** Unlocks the vault if needed, asks where to put it, writes a blank entry and opens it. */
export async function createVaultEntry(kind: NewEntryKind): Promise<void> {
  if (!(await useVaultStore.getState().ensureUnlocked())) return;
  try {
    await ensureVaultDir();
    const opt = NEW_ENTRY_OPTIONS.find((o) => o.kind === kind)!;
    const path = await pickVaultDestination(opt.label);
    if (!path) return;
    await writeAndOpen(kind, path);
  } catch (e) {
    toast.error(vaultErrorMessage(e));
  }
}

/** Default name for a new entry created straight from the sidebar (renamed inline right after). */
export const DEFAULT_ENTRY_NAME: Record<NewEntryKind, string> = {
  note: "Untitled note", login: "New login", ssh: "New server", secret: "New API key",
  card: "New card", wifi: "New Wi-Fi", codes: "New recovery codes",
};

/**
 * Writes a blank entry at `path` (a full `<root>/<rel>.nqv` path the caller has
 * checked is free) and opens it. Returns false (after a toast) on failure.
 */
export async function createVaultEntryAt(kind: NewEntryKind, path: string): Promise<boolean> {
  if (!(await useVaultStore.getState().ensureUnlocked())) return false;
  try {
    await writeAndOpen(kind, path);
    return true;
  } catch (e) {
    toast.error(vaultErrorMessage(e));
    return false;
  }
}

async function writeAndOpen(kind: NewEntryKind, path: string) {
  const title = nameOf(path);
  if (kind === "note") await vaultWriteFile(path, "", "md");
  else if (kind === "login") await vaultWriteFile(path, serializeLogin(emptyLogin(title)), LOGIN_EXT);
  else if (kind === "codes") await vaultWriteFile(path, serializeCodes(emptyCodes(title)), CODES_EXT);
  else await vaultWriteFile(path, serializeSecret(emptySecret(kind, title)), SECRET_KINDS[kind].ext);
  window.dispatchEvent(new Event(VAULT_DIR_EVENT));
  useAppStore.getState().openFilesAsTabs([await readFileEntry(path)]);
  if (await useVaultStore.getState().ensureUnlocked()) await useAppStore.getState().unlockVaultTabs();
}
