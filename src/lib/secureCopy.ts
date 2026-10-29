import { invoke } from "@tauri-apps/api/core";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { toast } from "./toast";

const CLEAR_AFTER_MS = 20_000;
let timer: ReturnType<typeof setTimeout> | undefined;

/**
 * Copies a secret and wipes the clipboard again after a short delay — but only
 * if it still holds that secret (so we never erase something the user copied since).
 *
 * The native `secure_copy` command also keeps the text out of Windows clipboard
 * history / the cloud clipboard and does the timed wipe itself; the plugin +
 * JS timer path is only a fallback for when that isn't available.
 */
export async function copySecret(text: string, label: string, opts?: { quiet?: boolean }): Promise<boolean> {
  let native = false;
  try {
    await invoke("secure_copy", { text, clearAfterMs: CLEAR_AFTER_MS });
    native = true;
  } catch { /* unsupported platform or clipboard busy: fall back below */ }

  if (!native) {
    try {
      await writeText(text);
    } catch {
      toast.error("Couldn't copy to the clipboard");
      return false;
    }
  }
  // `quiet`: the caller shows its own feedback (e.g. a check mark on the button).
  if (!opts?.quiet) toast.info(`${label} copied — clears in ${CLEAR_AFTER_MS / 1000} s`);
  clearTimeout(timer);
  if (!native) {
    timer = setTimeout(async () => {
      try {
        if ((await readText()) === text) await writeText("");
      } catch { /* clipboard unavailable: nothing to clear */ }
    }, CLEAR_AFTER_MS);
  }
  return true;
}
