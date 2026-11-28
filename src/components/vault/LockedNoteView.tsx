import { useEffect, useState } from "react";
import { CreditCard, FileLock2, IdCard, KeyRound, ListChecks, Terminal, Wifi, type LucideIcon } from "lucide-react";
import { LockHero } from "./LockHero";
import { useVaultStore } from "../../store/vaultStore";
import { useAppStore } from "../../store";
import { SECRET_KINDS } from "../../lib/secretEntry";
import { LOGIN_EXT } from "../../lib/loginEntry";
import { CODES_EXT } from "../../lib/recoveryCodes";
import type { Tab } from "../../types";

const ICONS: Record<string, LucideIcon> = {
  [LOGIN_EXT]: KeyRound, [CODES_EXT]: ListChecks,
  ssh: Terminal, secret: KeyRound, card: CreditCard, wifi: Wifi, identity: IdCard,
};

/** What the locked item is, from its kind alone (nothing is decrypted to find out). */
function kindOf(ext: string | undefined): { label: string; icon: LucideIcon } {
  const label = ext === LOGIN_EXT ? "Login" : ext === CODES_EXT ? "Recovery codes" : (ext && SECRET_KINDS[ext]?.label) || "Encrypted note";
  return { label, icon: (ext && ICONS[ext]) || FileLock2 };
}

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

  const { label, icon: KindIcon } = kindOf(tab.vaultExt);
  const title = tab.title.replace(/\.nqv$/i, "");

  return (
    <div
      data-tour="editor"
      className="flex-1 min-h-0 overflow-y-auto flex p-8 select-none bg-[var(--color-editor-bg)]"
    >
      {/* `m-auto`: centred, and still scrollable from the top in a very short window. */}
      <section aria-labelledby={`locked-${tab.id}`} className="m-auto w-full flex justify-center">
        <LockHero icon={KindIcon} badge eyebrow={label} title={title} titleId={`locked-${tab.id}`}
                  text="Unlock your vault to open this item." action="Unlock vault"
                  onUnlock={() => { void unlock(); }} busy={busy} autoFocus
                  note="Its contents stay encrypted until you unlock." />
      </section>
    </div>
  );
}
