import { useEffect, useState } from "react";
import { Lock } from "lucide-react";
import { Button } from "../ui/Button";
import { useVaultStore } from "../../store/vaultStore";
import { useAppStore } from "../../store";
import type { Tab } from "../../types";

/** Shown in place of the editor while a `.nqv` tab is locked. Shows no content. */
export function LockedNoteView({ tab }: { tab: Tab }) {
  const [busy, setBusy] = useState(false);

  const vaultUnlocked = useVaultStore((s) => s.unlocked);

  // The vault can already be unlocked while this tab is still a locked shell (e.g. the window
  // reloaded and restored the tab): there is no dialog to decrypt it, so do it here.
  useEffect(() => {
    if (vaultUnlocked) void useAppStore.getState().unlockVaultTabs();
  }, [vaultUnlocked]);

  const unlock = async () => {
    setBusy(true);
    try {
      // The dialog decrypts every locked tab on success; if the vault was already unlocked
      // there is no dialog, so decrypt explicitly.
      if (await useVaultStore.getState().ensureUnlocked()) await useAppStore.getState().unlockVaultTabs();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      data-tour="editor"
      className="flex-1 flex flex-col items-center justify-center gap-5 select-none bg-[var(--color-editor-bg)]"
    >
      <div
        className="flex items-center justify-center w-14 h-14 rounded-2xl"
        style={{
          background: "color-mix(in srgb, var(--color-primary) 12%, var(--color-bg-secondary))",
          color: "var(--color-primary)",
        }}
      >
        <Lock size={24} strokeWidth={1.5} />
      </div>
      <div className="text-center">
        <p className="text-sm font-semibold mb-1 text-[var(--color-text)]">{tab.title}</p>
        <p className="text-xs mb-4 text-[var(--color-text-muted)]">
          This note is locked. Enter your master password to open it.
        </p>
        <Button variant="primary" size="sm" icon={<Lock size={13} />} onClick={unlock} disabled={busy} autoFocus>
          Unlock
        </Button>
      </div>
    </div>
  );
}
