import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "../../store";
import { dirtyVaultTabs } from "../../lib/closeGuard";
import { isTauri } from "../../lib/tauriWindow";
import { toast } from "../../lib/toast";
import { flushVaultPendingOps } from "../../lib/vaultPendingOps";
import { ConfirmDialog } from "../ui/ConfirmDialog";

/**
 * Tray "Quit" with unsaved vault edits. Vault tabs are only ever persisted as
 * locked shells (no plaintext on disk), so quitting would drop those edits: ask
 * Save / Don't save / Cancel first. Plain notes keep their edits in the session
 * and need no question. See `quit_should_ask` in src-tauri/src/lib.rs.
 */

/** Applies held-back vault changes (an attachment removal still in its Undo window), then exits. */
const quitNow = async () => {
  await flushVaultPendingOps();
  void invoke("app_quit");
};
export function QuitGuard() {
  const [titles, setTitles] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listen("app-quit-requested", () => {
      const dirty = dirtyVaultTabs(useAppStore.getState().tabs);
      if (dirty.length === 0) { void quitNow(); return; }
      void invoke("show_main_window");
      setTitles(dirty.map((t) => t.title));
    })
      .then((fn) => {
        if (cancelled) { fn(); return; }
        unlisten = fn;
        void invoke("quit_guard_ready");
      })
      .catch((e) => console.warn("quit guard: couldn't listen for quit", e));
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  if (!titles) return null;

  const cancel = () => { setTitles(null); void invoke("quit_cancelled"); };
  const saveAndQuit = async () => {
    setSaving(true);
    const st = useAppStore.getState();
    for (const t of dirtyVaultTabs(st.tabs)) {
      if (!(await st.saveTabToFile(t.id))) {
        setSaving(false);
        toast.error(`Couldn't save "${t.title}", so Notiq is still open`);
        cancel();
        return;
      }
    }
    await quitNow();
  };

  const one = titles.length === 1;
  return (
    <ConfirmDialog
      title="Quit with unsaved changes?"
      message={one
        ? "This vault item has unsaved changes. Save them to the vault before quitting?"
        : `${titles.length} vault items have unsaved changes. Save them to the vault before quitting?`}
      detail={titles.join(", ")}
      icon="file"
      confirmLabel={saving ? "Saving…" : "Save & quit"}
      discardLabel="Don't save"
      cancelLabel="Cancel"
      onConfirm={() => { if (!saving) void saveAndQuit(); }}
      onDiscard={() => void quitNow()}
      onCancel={cancel}
    />
  );
}
