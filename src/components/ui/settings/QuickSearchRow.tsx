import { useEffect, useState } from "react";
import { SettingRow } from "../SettingRow";
import { Toggle } from "../Toggle";
import { Button } from "../Button";
import { ALL_SHORTCUTS } from "./settingsConstants";
import { comboFromEvent } from "../../../lib/shortcutCombo";
import { getPanicShortcut } from "../../../lib/vaultPrefs";
import {
  DEFAULT_QUICK_SEARCH_COMBO, quickSearchComboError, quickSearchGet, quickSearchSet,
} from "../../../quick/quickSearch";

const kbd = "font-mono text-xs px-2 py-1 rounded bg-[var(--color-bg-tertiary)] border border-[var(--color-border)]";
const errMsg = (e: unknown) => (typeof e === "string" ? e : e instanceof Error ? e.message : String(e));

/**
 * Quick search (0.7.0): opt-in system-wide hotkey that opens a small vault search popup.
 * The setting lives in the backend (quick_search.json) because the hotkey is registered in Rust.
 */
export function QuickSearchRow() {
  const [enabled, setEnabled] = useState(false);
  const [combo, setCombo]     = useState(DEFAULT_QUICK_SEARCH_COMBO);
  const [loaded, setLoaded]   = useState(false);
  const [busy, setBusy]       = useState(false);
  const [rec, setRec]         = useState(false);
  const [err, setErr]         = useState<string | null>(null);

  useEffect(() => {
    quickSearchGet()
      .then((s) => { setEnabled(s.enabled); setCombo(s.combo); setErr(s.error); })
      .catch((e) => setErr(errMsg(e)))
      .finally(() => setLoaded(true));
  }, []);

  const save = async (nextEnabled: boolean, nextCombo: string) => {
    setBusy(true);
    try {
      const s = await quickSearchSet(nextEnabled, nextCombo);
      setEnabled(s.enabled); setCombo(s.combo); setErr(null);
    } catch (e) {
      setErr(errMsg(e)); // the previous setting stays active
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!rec) return;
    const h = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === "Escape") { setRec(false); setErr(null); return; }
      const c = comboFromEvent(e);
      if (!c) return; // only modifiers so far
      const bad = quickSearchComboError(c, ALL_SHORTCUTS, getPanicShortcut());
      if (bad) { setErr(bad); return; }
      setRec(false);
      void save(enabled, c);
    };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [rec, enabled]);

  const shortcutDescription = err
    ?? (rec ? "Press the new key combination… (Esc to cancel)"
      : `Press ${combo} anywhere on your computer to open the search popup.`);

  return (
    <>
      <SettingRow
        id="vault.quicksearch.enabled"
        label="Quick search hotkey"
        description="Search your vault and copy a password from anywhere on your computer, without opening Notiq. Off by default."
        keywords={["quick search", "global shortcut", "popup", "copy password", "system-wide"]}
        modified={enabled}
        onReset={() => void save(false, combo)}
      >
        <Toggle aria-label="Enable quick search hotkey" disabled={!loaded || busy} value={enabled}
                onChange={(v) => void save(v, combo)} />
      </SettingRow>
      <SettingRow
        id="vault.quicksearch.shortcut"
        label="Quick search shortcut"
        description={shortcutDescription}
        keywords={["quick search", "hotkey", "key combination", "keybinding"]}
        modified={combo !== DEFAULT_QUICK_SEARCH_COMBO}
        onReset={() => void save(enabled, DEFAULT_QUICK_SEARCH_COMBO)}
      >
        <div className="flex items-center gap-2">
          <kbd className={kbd}>{rec ? "Press keys…" : combo}</kbd>
          <Button className="settings-btn" size="sm" disabled={!loaded || busy} onClick={() => { setErr(null); setRec((r) => !r); }}>
            {rec ? "Cancel" : "Change"}
          </Button>
        </div>
      </SettingRow>
    </>
  );
}
