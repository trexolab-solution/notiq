import { useEffect } from "react";
import { useVaultStore } from "../store/vaultStore";
import { toast } from "../lib/toast";
import { FILE_SAVED_EVENT, errText, getTgAutoSync, runSync, tgStatus } from "../lib/telegram";

const DEBOUNCE_MS = 8000;

/** Optional: back up to Telegram a few seconds after a vault note is saved. */
export function useTelegramAutoSync() {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false;
    const fire = async () => {
      if (running || !getTgAutoSync() || !useVaultStore.getState().unlocked) return;
      running = true;
      try {
        if (!(await tgStatus()).configured) return;
        const rep = await runSync();
        if (rep && rep.failed.length) toast.error(`Telegram sync: ${rep.failed[0]}`);
      } catch (e) {
        toast.error(`Telegram sync failed: ${errText(e)}`);
      } finally {
        running = false;
      }
    };
    const onSaved = () => {
      if (!getTgAutoSync()) return;
      clearTimeout(timer);
      timer = setTimeout(() => { void fire(); }, DEBOUNCE_MS);
    };
    window.addEventListener(FILE_SAVED_EVENT, onSaved);
    return () => { window.removeEventListener(FILE_SAVED_EVENT, onSaved); clearTimeout(timer); };
  }, []);
}
