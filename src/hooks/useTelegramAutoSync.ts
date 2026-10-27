import { useEffect } from "react";
import { useVaultStore } from "../store/vaultStore";
import { useAppStore } from "../store";
import { toast } from "../lib/toast";
import { backupReminderDue } from "../lib/backupPrompt";
import { FILE_SAVED_EVENT, PULLED_EVENT, errText, getTgAutoSync, runSync, tgStatus } from "../lib/telegram";

const DEBOUNCE_MS = 8000;
const PERIODIC_MS = 5 * 60 * 1000;

/**
 * Two-way Sync (on by default once Telegram is connected): when the
 * vault unlocks, a few seconds after a note is saved, and every few minutes.
 */
export function useTelegramAutoSync() {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false;
    let again = false;
    const fire = async () => {
      if (!getTgAutoSync() || !useVaultStore.getState().unlocked) return;
      if (running) { again = true; return; }
      running = true;
      try {
        if (!(await tgStatus()).configured) return;
        const rep = await runSync();
        if (!rep) return;
        if (rep.downloaded.length) toast.info(`Sync: ${rep.downloaded.length} note${rep.downloaded.length > 1 ? "s" : ""} updated from another device`);
        if (rep.conflicts) toast.info(`Sync: ${rep.conflicts} note${rep.conflicts > 1 ? "s were" : " was"} edited on two devices — the older version was kept as "(conflict …)"`);
        if (rep.failed.length) toast.error(`Sync: ${rep.failed[0]}`);
      } catch (e) {
        toast.error(`Sync failed: ${errText(e)}`);
      } finally {
        running = false;
        if (again) { again = false; schedule(); }
      }
    };
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { void fire(); }, DEBOUNCE_MS);
    };
    const onSaved = () => { if (getTgAutoSync()) schedule(); };
    const onPulled = () => { void useAppStore.getState().refreshVaultTabs(); };

    // Pull as soon as the vault unlocks (also covers app start + new-device restore).
    const unsub = useVaultStore.subscribe((s, prev) => {
      if (s.unlocked && !prev.unlocked) {
        setTimeout(() => { void fire(); }, 1500);
        // Not backed up? Remind (at most every few days).
        setTimeout(async () => {
          try {
            if (!(await tgStatus()).configured && backupReminderDue() && !useVaultStore.getState().dialog) {
              useVaultStore.getState().setBackupPrompt(true);
            }
          } catch { /* ignore */ }
        }, 4000);
      }
    });
    const interval = setInterval(() => { void fire(); }, PERIODIC_MS);

    window.addEventListener(FILE_SAVED_EVENT, onSaved);
    window.addEventListener(PULLED_EVENT, onPulled);
    return () => {
      window.removeEventListener(FILE_SAVED_EVENT, onSaved);
      window.removeEventListener(PULLED_EVENT, onPulled);
      unsub(); clearInterval(interval); clearTimeout(timer);
    };
  }, []);
}
