import { toast } from "../../lib/toast";

const KEY = "notiq:trayNoticeShown";

/** Shows the "still running in the tray" notice the first time the window is closed; never throws. */
export function maybeShowTrayNotice(): boolean {
  try {
    if (localStorage.getItem(KEY)) return false;
    localStorage.setItem(KEY, "1");
  } catch {
    return false; // storage blocked: skip rather than nag on every close
  }
  toast.info("Notiq is still running in the tray. Right-click the tray icon to quit.", 8000);
  return true;
}
