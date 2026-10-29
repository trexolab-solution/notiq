import { useEffect, useState } from "react";
import { FolderOpen } from "lucide-react";
import { SettingRow } from "../SettingRow";
import { SettingsBlock } from "../SettingsGroup";
import { Toggle } from "../Toggle";
import { PasswordOptionsForm } from "../../vault/PasswordOptionsForm";
import { Button } from "../Button";
import { ALL_SHORTCUTS } from "./settingsConstants";
import { comboFromEvent, hasRequiredModifier, normalizeCombo } from "../../../lib/shortcutCombo";
import {
  DEFAULT_PANIC_SHORTCUT, getPanicShortcut, setPanicShortcut, getVaultDir,
  PW_PREFS_EVENT, getPwAsk, setPwAsk, getPwOptions, setPwOptions,
} from "../../../lib/vaultPrefs";
import { DEFAULT_PW_OPTIONS, sanitizePwOptions } from "../../../lib/passwordGen";
import { cloudFolderName } from "../../../lib/cloudFolders";
import { resolveVaultDir, pickVaultDir, resetVaultDir, VAULT_DIR_EVENT } from "../../../lib/vaultDir";

const kbd = "font-mono text-xs px-2 py-1 rounded bg-[var(--color-bg-tertiary)] border border-[var(--color-border)]";

function validate(combo: string): string | null {
  if (!hasRequiredModifier(combo)) return "Use Ctrl, Alt or Cmd with a key (or a function key)";
  const n = normalizeCombo(combo);
  const clash = ALL_SHORTCUTS.find((s) => s.label !== "Lock vault now" && normalizeCombo(s.key) === n);
  return clash ? `Already used by "${clash.label}"` : null;
}

export function PanicShortcutRow() {
  const [combo, setCombo] = useState(getPanicShortcut);
  const [rec, setRec]     = useState(false);
  const [err, setErr]     = useState<string | null>(null);

  useEffect(() => {
    if (!rec) return;
    const h = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === "Escape") { setRec(false); setErr(null); return; }
      const c = comboFromEvent(e);
      if (!c) return; // only modifiers so far
      const bad = validate(c);
      if (bad) { setErr(bad); return; }
      setPanicShortcut(c); setCombo(c); setErr(null); setRec(false);
    };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [rec]);

  const reset = () => { setPanicShortcut(DEFAULT_PANIC_SHORTCUT); setCombo(DEFAULT_PANIC_SHORTCUT); setErr(null); setRec(false); };

  return (
    <SettingRow
      id="vault.locking.panic-shortcut"
      label="Panic lock shortcut"
      description={err ?? (rec ? "Press the new key combination… (Esc to cancel)" : "Instantly saves and locks the vault from anywhere in the app.")}
      keywords={["panic", "hotkey", "keybinding", "lock now", "emergency"]}
      modified={combo !== DEFAULT_PANIC_SHORTCUT}
      onReset={reset}
    >
      <div className="flex items-center gap-2">
        <kbd className={kbd}>{rec ? "Press keys…" : combo}</kbd>
        <Button className="settings-btn" size="sm" onClick={() => { setErr(null); setRec((r) => !r); }}>{rec ? "Cancel" : "Change"}</Button>
      </div>
    </SettingRow>
  );
}

export function StorageFolderRow() {
  const [dir, setDir] = useState("");
  const [custom, setCustom] = useState(() => getVaultDir() !== null);
  const cloud = dir ? cloudFolderName(dir) : null;
  useEffect(() => {
    const load = () => { setCustom(getVaultDir() !== null); void resolveVaultDir().then(setDir); };
    load();
    window.addEventListener(VAULT_DIR_EVENT, load);
    return () => window.removeEventListener(VAULT_DIR_EVENT, load);
  }, []);

  return (
    <SettingRow
      id="vault.storage.folder"
      label="Vault storage folder"
      description={`${dir || "…"}${custom ? "" : "  (default)"} — where your encrypted vault file (vault.nqdb) is kept.${cloud ? ` Warning: this folder is synced by ${cloud}.` : ""}`}
      keywords={["folder", "directory", "location", "path", "vault.nqdb", "cloud", "onedrive", "dropbox", "sync", "move"]}
      modified={custom}
      onReset={() => void resetVaultDir()}
    >
      <Button className="settings-btn" size="sm" icon={<FolderOpen size={12} />} onClick={() => void pickVaultDir()}>Choose…</Button>
    </SettingRow>
  );
}

/** Defaults for the Generate button in Login entries (also reachable from the popup's ⚙ button). */
export function PasswordGeneratorRow() {
  const [ask, setAsk] = useState(getPwAsk);
  const [opts, setOpts] = useState(getPwOptions);
  useEffect(() => {
    const sync = () => { setAsk(getPwAsk()); setOpts(getPwOptions()); };
    window.addEventListener(PW_PREFS_EVENT, sync);
    return () => window.removeEventListener(PW_PREFS_EVENT, sync);
  }, []);

  const optsModified = JSON.stringify(sanitizePwOptions(opts)) !== JSON.stringify(DEFAULT_PW_OPTIONS);
  const resetOpts = () => { setOpts(DEFAULT_PW_OPTIONS); setPwOptions(DEFAULT_PW_OPTIONS); };

  return (
    <>
      <SettingRow
        id="vault.generator.ask"
        label="Ask for options each time"
        description="Show the options popup when you press Generate. Turn it off to generate instantly with the settings below."
        keywords={["password generator", "generate", "popup", "prompt"]}
        modified={!ask}
        onReset={() => { setAsk(true); setPwAsk(true); }}
      >
        <Toggle aria-label="Ask for options each time" value={ask} onChange={(v) => { setAsk(v); setPwAsk(v); }} />
      </SettingRow>
      <SettingsBlock
        id="vault.generator.options"
        label="Generated password options"
        description="Length and character types used by Generate in Login entries."
        keywords={["password generator", "length", "symbols", "digits", "uppercase", "lowercase", "ambiguous", "characters"]}
      >
        <div className="flex flex-col gap-2 items-start">
          <div className="rounded-lg p-3 border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] max-w-sm w-full">
            <PasswordOptionsForm value={opts} onChange={(o) => { setOpts(o); setPwOptions(o); }} />
          </div>
          {optsModified && <Button className="settings-btn" size="sm" variant="ghost" onClick={resetOpts}>Reset to defaults</Button>}
        </div>
      </SettingsBlock>
    </>
  );
}
