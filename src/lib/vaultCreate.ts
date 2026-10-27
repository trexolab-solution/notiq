import { useAppStore } from "../store";
import { useVaultStore } from "../store/vaultStore";
import { ensureVaultDir, VAULT_DIR_EVENT } from "./vaultDir";
import { pickVaultDestination } from "./vaultDest";
import { vaultWriteFile, vaultErrorMessage } from "./vault";
import { readFileEntry } from "./fileOps";
import { emptyLogin, LOGIN_EXT, serializeLogin } from "./loginEntry";
import { emptySecret, SECRET_KINDS, serializeSecret } from "./secretEntry";
import { toast } from "./toast";

export type NewEntryKind = "note" | "login" | "ssh" | "secret";

export const NEW_ENTRY_OPTIONS: { kind: NewEntryKind; label: string; hint: string }[] = [
  { kind: "note",   label: "Secure note",     hint: "Free text, Markdown" },
  { kind: "login",  label: "Login",           hint: "Site, username, password, 2-step code" },
  { kind: "ssh",    label: SECRET_KINDS.ssh.label,    hint: SECRET_KINDS.ssh.hint },
  { kind: "secret", label: SECRET_KINDS.secret.label, hint: SECRET_KINDS.secret.hint },
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
    const title = nameOf(path);
    if (kind === "note") await vaultWriteFile(path, "", "md");
    else if (kind === "login") await vaultWriteFile(path, serializeLogin(emptyLogin(title)), LOGIN_EXT);
    else await vaultWriteFile(path, serializeSecret(emptySecret(kind, title)), SECRET_KINDS[kind].ext);
    window.dispatchEvent(new Event(VAULT_DIR_EVENT));
    useAppStore.getState().openFilesAsTabs([await readFileEntry(path)]);
    if (await useVaultStore.getState().ensureUnlocked()) await useAppStore.getState().unlockVaultTabs();
  } catch (e) {
    toast.error(vaultErrorMessage(e));
  }
}
