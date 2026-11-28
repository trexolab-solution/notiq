import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";
import { APP_VERSION } from "../config/app";

/** The version whose first launch last made sure Notiq starts at sign-in. */
const ENSURED_KEY = "autostart:ensuredVersion";
/** Set while the user has "Launch at sign-in" turned off in Notiq. Nothing turns it back on then. */
const OFF_KEY = "autostart:userOff";

const read = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k: string, v: string | null) => {
  try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* not remembered */ }
};

/**
 * Launch at sign-in is on by default and is made sure of after every update: the first launch of each version
 * writes the startup entry again, with this program's path. That also repairs an entry that went missing or points
 * somewhere else. It is left alone once the user turned it off in Notiq. A failed try is repeated next launch.
 */
export async function ensureAutostart(dev: boolean = import.meta.env.DEV): Promise<void> {
  // A dev build must not register itself (the debug exe) to start with the OS.
  if (dev || read(OFF_KEY) || read(ENSURED_KEY) === APP_VERSION) return;
  try {
    await enable();
    write(ENSURED_KEY, APP_VERSION);
  } catch (err) {
    console.warn("autostart: couldn't make sure Notiq starts at sign-in", err);
  }
}

/** The user's own choice (Settings → General). A dev build shares the entry's name with the installed app. */
export async function setAutostart(on: boolean, dev: boolean = import.meta.env.DEV): Promise<void> {
  if (dev) throw new Error("A development build doesn't change what starts with Windows");
  if (on) await enable(); else await disable();
  write(OFF_KEY, on ? null : "1");
}

export { isEnabled };
