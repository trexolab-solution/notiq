import { useEffect, useState } from "react";
import { FolderOpen, RotateCcw } from "lucide-react";
import { SettingRow } from "../SettingRow";
import { Button } from "../Button";
import { ALL_SHORTCUTS } from "./settingsConstants";
import { comboFromEvent, hasRequiredModifier, normalizeCombo } from "../../../lib/shortcutCombo";
import {
  DEFAULT_PANIC_SHORTCUT, getPanicShortcut, setPanicShortcut, getVaultDir,
} from "../../../lib/vaultPrefs";
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
      label="Panic lock shortcut"
      description={err ?? (rec ? "Press the new key combination… (Esc to cancel)" : "Instantly saves and locks the vault from anywhere in the app.")}
    >
      <div className="flex items-center gap-2">
        <kbd className={kbd}>{rec ? "Press keys…" : combo}</kbd>
        <Button size="sm" onClick={() => { setErr(null); setRec((r) => !r); }}>{rec ? "Cancel" : "Change"}</Button>
        {combo !== DEFAULT_PANIC_SHORTCUT && (
          <Button size="sm" variant="ghost" onClick={reset} aria-label="Reset shortcut"><RotateCcw size={12} /></Button>
        )}
      </div>
    </SettingRow>
  );
}

export function StorageFolderRow() {
  const [dir, setDir] = useState("");
  const [custom, setCustom] = useState(() => getVaultDir() !== null);
  useEffect(() => {
    const load = () => { setCustom(getVaultDir() !== null); void resolveVaultDir().then(setDir); };
    load();
    window.addEventListener(VAULT_DIR_EVENT, load);
    return () => window.removeEventListener(VAULT_DIR_EVENT, load);
  }, []);

  return (
    <SettingRow
      label="Vault storage folder"
      description={`${dir || "…"}${custom ? "" : "  (default)"} — shown in the sidebar vault panel and used for new locked notes.`}
    >
      <div className="flex items-center gap-2">
        <Button size="sm" icon={<FolderOpen size={12} />} onClick={() => void pickVaultDir()}>Choose…</Button>
        {custom && <Button size="sm" variant="ghost" onClick={resetVaultDir}>Default</Button>}
      </div>
    </SettingRow>
  );
}
