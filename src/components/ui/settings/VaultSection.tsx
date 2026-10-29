import React, { useEffect, useState } from "react";
import { SettingRow } from "../SettingRow";
import { SettingsGroup, SettingsBlock } from "../SettingsGroup";
import { Button } from "../Button";
import { Toggle } from "../Toggle";
import { Select } from "../Select";
import { PasswordInput } from "../PasswordInput";
import { PanicShortcutRow, PasswordGeneratorRow, StorageFolderRow } from "./VaultPrefRows";
import { SessionLockRow } from "./SessionLockRow";
import { QuickSearchRow } from "./QuickSearchRow";
import { BackupSection } from "../../vault/BackupSection";
import { AutofillSection } from "./AutofillSection";
import { HelloRow } from "./HelloRow";
import { helloStatus } from "../../../lib/hello";
import { toast } from "../../../lib/toast";
import { useAppStore } from "../../../store";
import { useVaultStore } from "../../../store/vaultStore";
import { vaultChangePassword, vaultErrorMessage } from "../../../lib/vault";
import {
  IDLE_OPTIONS, DEFAULT_IDLE_MINUTES, getIdleMinutes, setIdleMinutes, getLockOnHide, setLockOnHide,
} from "../../../lib/vaultPrefs";
import type { SettingMeta } from "../../../lib/settingsIndex";

const MIN_LEN = 8;

const STATE_TEXT = {
  none: "The vault isn't set up yet. Lock individual notes with a master password (right-click a tab, then Lock with Vault).",
  locked: "The vault is locked. Enter your master password to read locked notes.",
  unlocked: "The vault is unlocked. Locked notes are readable until it locks.",
};

const idleLabel = (m: number) => (m === 0 ? "Never" : m === 1 ? "1 minute" : m === 60 ? "1 hour" : `${m} minutes`);

export const VaultSection = React.memo(function VaultSection() {
  const exists   = useVaultStore((s) => s.exists);
  const unlocked = useVaultStore((s) => s.unlocked);
  useEffect(() => { void useVaultStore.getState().refresh(); }, []);

  const [idle, setIdle]       = useState(() => getIdleMinutes());
  const [onHide, setOnHide]   = useState(() => getLockOnHide());

  const [oldPw, setOldPw]     = useState("");
  const [newPw, setNewPw]     = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [busy, setBusy]       = useState(false);
  const [error, setError]     = useState<string | null>(null);

  const changePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (newPw.length < MIN_LEN) { setError(`New password must be at least ${MIN_LEN} characters`); return; }
    if (newPw !== confirmPw)    { setError("New passwords don't match"); return; }
    setBusy(true);
    setError(null);
    try {
      await vaultChangePassword(oldPw, newPw);
      useVaultStore.getState().setUnlocked(true);
      setOldPw(""); setNewPw(""); setConfirmPw("");
      toast.info("Master password changed. Your locked notes and recovery key still work.");
    } catch (err) {
      setError(vaultErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const state = !exists ? "none" : unlocked ? "unlocked" : "locked";
  const changeIdle = (n: number) => { setIdle(n); setIdleMinutes(n); };

  return (
    <div className="flex flex-col gap-5">
      <SettingsGroup title="Locking" description="When the vault locks itself, and how to lock it by hand.">
        <SettingRow
          id="vault.locking.lock-now"
          label="Vault status"
          description={STATE_TEXT[state]}
          keywords={["lock now", "lock", "unlock", "set up vault", "create vault", "master password"]}
        >
          {state === "none" && (
            <Button variant="primary" size="sm" onClick={() => void useVaultStore.getState().ensureUnlocked()}>Set up vault</Button>
          )}
          {state === "locked" && (
            <Button variant="primary" size="sm" onClick={() => void useVaultStore.getState().ensureUnlocked()}>Unlock</Button>
          )}
          {state === "unlocked" && (
            <Button size="sm" onClick={() => void useAppStore.getState().lockVault()}>Lock now</Button>
          )}
        </SettingRow>

        <SettingRow
          id="vault.locking.auto-lock"
          label="Auto-lock after inactivity"
          description="Locks the vault when you haven't used the app for this long."
          keywords={["idle", "timeout", "inactive", "minutes", "automatically lock"]}
          modified={idle !== DEFAULT_IDLE_MINUTES}
          onReset={() => changeIdle(DEFAULT_IDLE_MINUTES)}
        >
          <Select
            aria-label="Auto-lock timeout"
            value={String(idle)}
            onChange={(v) => changeIdle(Number(v))}
            options={IDLE_OPTIONS.map((m) => ({ value: String(m), label: idleLabel(m) }))}
          />
        </SettingRow>

        <SettingRow
          id="vault.locking.on-close"
          label="Lock when the window is closed"
          description="Closing Notiq hides it in the tray; this locks the vault at that moment."
          keywords={["close", "tray", "hide", "exit"]}
          modified={!onHide}
          onReset={() => { setOnHide(true); setLockOnHide(true); }}
        >
          <Toggle
            aria-label="Lock when the window is closed"
            value={onHide}
            onChange={(v) => { setOnHide(v); setLockOnHide(v); }}
          />
        </SettingRow>

        <PanicShortcutRow />
        <SessionLockRow />
      </SettingsGroup>

      <SettingsGroup title="Storage" description="Where the encrypted vault file lives on this computer.">
        <StorageFolderRow />
      </SettingsGroup>

      <SettingsGroup
        title="Backup"
        description="Your vault lives only on this computer. Keep an encrypted copy somewhere else."
      >
        <BackupSection />
      </SettingsGroup>

      <HelloGroup />

      <SettingsGroup title="Quick search" description="Search your vault from anywhere with a global hotkey.">
        <QuickSearchRow />
      </SettingsGroup>

      <SettingsGroup title="Password generator" description="Defaults for the Generate button in Login entries.">
        <PasswordGeneratorRow />
      </SettingsGroup>

      <SettingsGroup title="Master password">
        <SettingsBlock
          id="vault.password.change"
          label="Change master password"
          description="Your locked notes don't need re-encrypting, and your recovery key keeps working."
          keywords={["password", "change", "new password", "recovery key", "credentials"]}
        >
          {exists ? (
            <form onSubmit={changePassword} className="flex flex-col gap-3 max-w-sm">
              <h4 className="text-sm font-medium text-[var(--color-text)]">Change master password</h4>
              <PasswordInput placeholder="Current password" autoComplete="current-password" aria-label="Current password"
                     value={oldPw} onChange={(e) => setOldPw(e.target.value)} />
              <PasswordInput placeholder="New password" autoComplete="new-password" aria-label="New password"
                     value={newPw} onChange={(e) => setNewPw(e.target.value)} />
              <PasswordInput placeholder="Confirm new password" autoComplete="new-password" aria-label="Confirm new password"
                     value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} />
              {error && <p role="alert" className="text-xs text-[var(--color-danger)]">{error}</p>}
              <div>
                <Button type="submit" variant="primary" size="sm" disabled={busy || !oldPw || !newPw}>
                  {busy ? "Working…" : "Change password"}
                </Button>
              </div>
              <p className="text-xs text-[var(--color-text-muted)]">
                Your locked notes don't need re-encrypting, and your recovery key keeps working.
              </p>
            </form>
          ) : (
            <p className="text-sm text-[var(--color-text-muted)]">Set up the vault first to have a master password to change.</p>
          )}
        </SettingsBlock>
      </SettingsGroup>

      <SettingsGroup title="Browser autofill" description="Fill logins from your vault in Edge, Chrome or Brave.">
        <AutofillSection />
      </SettingsGroup>
    </div>
  );
});

/** "Quick unlock" group; hidden entirely where Windows Hello isn't available (HelloRow renders nothing then). */
function HelloGroup() {
  const [supported, setSupported] = useState(false);
  useEffect(() => {
    let live = true;
    void helloStatus().then((st) => { if (live) setSupported(st.supported); });
    return () => { live = false; };
  }, []);
  if (!supported) return null;
  return (
    <SettingsGroup title="Quick unlock" description="Optional shortcuts for unlocking the vault.">
      <HelloRow />
    </SettingsGroup>
  );
}


/** Every searchable setting this section renders (see lib/settingsIndex.ts). */
export const SETTINGS_INDEX: SettingMeta[] = [
  { id: "vault.locking.lock-now", section: "vault", group: "Locking", label: "Vault status",
    description: "Whether the vault is set up, locked or unlocked, with a button to set up, unlock or lock it.",
    keywords: ["lock now", "lock", "unlock", "set up vault", "create vault", "master password"] },
  { id: "vault.locking.auto-lock", section: "vault", group: "Locking", label: "Auto-lock after inactivity",
    description: "Locks the vault when you haven't used the app for this long.",
    keywords: ["idle", "timeout", "inactive", "minutes", "automatically lock"] },
  { id: "vault.locking.on-close", section: "vault", group: "Locking", label: "Lock when the window is closed",
    description: "Closing Notiq hides it in the tray; this locks the vault at that moment.",
    keywords: ["close", "tray", "hide", "exit"] },
  { id: "vault.locking.panic-shortcut", section: "vault", group: "Locking", label: "Panic lock shortcut",
    description: "Instantly saves and locks the vault from anywhere in the app.",
    keywords: ["panic", "hotkey", "keybinding", "lock now", "emergency"] },
  { id: "vault.locking.on-session-lock", section: "vault", group: "Locking", label: "Lock when Windows locks or sleeps",
    description: "Locks the vault when you lock your PC (Win+L), it goes to sleep, or a remote session disconnects.",
    keywords: ["session", "sleep", "suspend", "win+l", "remote desktop", "windows lock"] },
  { id: "vault.locking.auto-hide", section: "vault", group: "Locking", label: "Auto-hide revealed secrets",
    description: "Hides a shown password or key again after this time, or as soon as the window loses focus.",
    keywords: ["reveal", "show password", "hide", "timeout"] },
  { id: "vault.storage.folder", section: "vault", group: "Storage", label: "Vault storage folder",
    description: "Where your encrypted vault file (vault.nqdb) is kept. Warns if the folder is synced by a cloud service.",
    keywords: ["folder", "directory", "location", "path", "vault.nqdb", "cloud", "onedrive", "dropbox", "sync", "move"] },
  { id: "vault.backup.export", section: "vault", group: "Backup", label: "Export encrypted backup",
    description: "Save an encrypted copy of your vault and see when you last backed up. The file stays protected by your master password and recovery key.",
    keywords: ["backup", "last backup", "export", "save a copy", ".nqbackup", "encrypted"] },
  { id: "vault.backup.import", section: "vault", group: "Backup", label: "Import backup",
    description: "Restore a .nqbackup file. If a vault already exists here it will be replaced (a copy is kept).",
    keywords: ["restore", "backup", "import", ".nqbackup", "recover"] },
  { id: "vault.backup.remind", section: "vault", group: "Backup", label: "Remind me to back up",
    description: "A reminder appears if you never backed up (after 3 days) or the last backup is over 30 days old.",
    keywords: ["backup", "reminder", "notification", "nag"] },
  { id: "vault.quickunlock.hello", section: "vault", group: "Quick unlock", label: "Windows Hello (experimental)",
    description: "Unlock with your face, fingerprint or Windows PIN instead of typing the master password.",
    keywords: ["windows hello", "fingerprint", "face", "pin", "biometric", "quick unlock", "unlock"] },
  { id: "vault.quicksearch.enabled", section: "vault", group: "Quick search", label: "Quick search hotkey",
    description: "Search your vault and copy a password from anywhere on your computer, without opening Notiq. Off by default.",
    keywords: ["quick search", "global shortcut", "popup", "copy password", "system-wide"] },
  { id: "vault.quicksearch.shortcut", section: "vault", group: "Quick search", label: "Quick search shortcut",
    description: "The key combination that opens the search popup.",
    keywords: ["quick search", "hotkey", "key combination", "keybinding"] },
  { id: "vault.generator.ask", section: "vault", group: "Password generator", label: "Ask for options each time",
    description: "Show the options popup when you press Generate. Turn it off to generate instantly with the settings below.",
    keywords: ["password generator", "generate", "popup", "prompt"] },
  { id: "vault.generator.options", section: "vault", group: "Password generator", label: "Generated password options",
    description: "Length and character types used by Generate in Login entries.",
    keywords: ["password generator", "length", "symbols", "digits", "uppercase", "lowercase", "ambiguous", "characters"] },
  { id: "vault.password.change", section: "vault", group: "Master password", label: "Change master password",
    description: "Your locked notes don't need re-encrypting, and your recovery key keeps working.",
    keywords: ["password", "change", "new password", "recovery key", "credentials"] },
  { id: "vault.autofill.install", section: "vault", group: "Browser autofill", label: "Install the browser extension",
    description: "Load the Notiq extension into Edge, Chrome or Brave to fill logins from your vault.",
    keywords: ["extension", "chrome", "edge", "brave", "firefox", "developer mode", "load unpacked", "autofill", "browser"] },
  { id: "vault.autofill.connection", section: "vault", group: "Browser autofill", label: "Browser connection",
    description: "Lets the Notiq browser extension reach this app. Repair re-registers Notiq with every installed browser.",
    keywords: ["repair", "native host", "register", "extension", "bridge", "refresh"] },
  { id: "vault.autofill.status", section: "vault", group: "Browser autofill", label: "Browser registration and status",
    description: "Which browsers Notiq is registered with, whether the local bridge is running, and when the extension was last seen.",
    keywords: ["status", "bridge", "extension last seen", "registered", "last request", "diagnostics"] },
];
