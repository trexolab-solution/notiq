import { useVaultStore } from "../../../store/vaultStore";
import { vaultErrorMessage, vaultReadFile } from "../../../lib/vault";
import { parseLogin } from "../../../lib/loginEntry";
import { copySecret } from "../../../lib/secureCopy";
import { toFull } from "../../../lib/vaultTree";
import { recordUse } from "../../../lib/vaultUsage";
import { toast } from "../../../lib/toast";

export type LoginField = "username" | "password";

/**
 * Copies a saved login's username or password straight from the sidebar, without opening the entry.
 * The password goes through `copySecret`, so it is wiped from the clipboard after the usual delay.
 */
export async function copyLoginField(root: string, rel: string, field: LoginField): Promise<boolean> {
  if (!(await useVaultStore.getState().ensureUnlocked())) return false;
  try {
    const entry = parseLogin((await vaultReadFile(toFull(root, rel))).content);
    const value = entry[field];
    if (!value) { toast.info(`This login has no ${field} saved`); return false; }
    const ok = await copySecret(value, field === "password" ? "Password" : "Username");
    if (ok) recordUse(rel);
    return ok;
  } catch (e) {
    toast.error(vaultErrorMessage(e));
    return false;
  }
}
