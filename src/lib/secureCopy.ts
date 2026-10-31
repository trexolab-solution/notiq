import { invoke } from "@tauri-apps/api/core";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { toast } from "./toast";
import { clipboardClearLabel, getClipboardClearSeconds } from "./vaultPrefs";

let timer: ReturnType<typeof setTimeout> | undefined;

/** The toast after a copy: says when the clipboard will be cleared (Settings → Vault), if ever. */
export function copiedMessage(label: string, clearSeconds: number): string {
  return clearSeconds > 0 ? `${label} copied — clears in ${clipboardClearLabel(clearSeconds)}` : `${label} copied`;
}

/**
 * Copies a secret and wipes the clipboard again after the user's "Clear copied secrets after" setting
 * (Settings → Vault; default 30 s, or never) — but only if it still holds that secret (so we never erase
 * something the user copied since). A new copy cancels the previous copy's pending wipe.
 *
 * The native `secure_copy` command also keeps the text out of Windows clipboard
 * history / the cloud clipboard and does the timed wipe itself; the plugin +
 * JS timer path is only a fallback for when that isn't available.
 *
 * `copySecretTimed` resolves to the clear delay in seconds (0 = never) or null when nothing was copied.
 */
export async function copySecretTimed(text: string, label: string, opts?: { quiet?: boolean }): Promise<number | null> {
  const clearSeconds = getClipboardClearSeconds();
  const clearAfterMs = clearSeconds * 1000;
  let native = false;
  try {
    await invoke("secure_copy", { text, clearAfterMs });
    native = true;
  } catch { /* unsupported platform or clipboard busy: fall back below */ }

  if (!native) {
    try {
      await writeText(text);
    } catch {
      toast.error("Couldn't copy to the clipboard");
      return null;
    }
  }
  // `quiet`: the caller shows its own feedback (e.g. a check mark on the button).
  if (!opts?.quiet) toast.info(copiedMessage(label, clearSeconds));
  clearTimeout(timer);
  if (!native && clearAfterMs > 0) {
    timer = setTimeout(async () => {
      try {
        if ((await readText()) === text) await writeText("");
      } catch { /* clipboard unavailable: nothing to clear */ }
    }, clearAfterMs);
  }
  return clearSeconds;
}

/** {@link copySecretTimed} that resolves to whether the copy worked. */
export async function copySecret(text: string, label: string, opts?: { quiet?: boolean }): Promise<boolean> {
  return (await copySecretTimed(text, label, opts)) !== null;
}
