import { invoke } from "@tauri-apps/api/core";
import { applyTheme } from "../../lib/themes";
import { resolveVaultDir } from "../../lib/vaultDir";
import { ERR_LOCKED, vaultStatus } from "../../lib/vault";
import { scanLogins } from "../../lib/autofill";
import type { PopupDeps } from "../../lib/autofillPopup";

export const LABEL = "autofill-prompt";
export type ThemeId = Parameters<typeof applyTheme>[0];

export const reply = (id: string, payload: unknown) => invoke("autofill_reply", { id, payload }).catch(() => {});

/** No file-system access here: just tell the backend where the vault folder is. */
export async function promptVaultRoot(): Promise<string> {
  const root = await resolveVaultDir();
  await invoke("vault_set_root", { root });
  return root;
}

export const nextTask = () => new Promise<void>((r) => setTimeout(r, 0));

/** The toolbar popup's silent requests (list, username copy): no window, no unlock offer. */
export const popupDeps: PopupDeps = {
  prepare: promptVaultRoot,
  unlocked: async () => (await vaultStatus()).unlocked,
  scan: async (host) => (await scanLogins(host)).matches,
  lockedError: ERR_LOCKED,
};
