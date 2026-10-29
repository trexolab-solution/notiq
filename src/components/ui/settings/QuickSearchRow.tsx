import { useEffect, useState } from "react";
import { RotateCcw } from "lucide-react";
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

  const description = err
    ?? (rec ? "Press the new key combination… (Esc to cancel)"
      : `Press ${combo} anywhere on your computer to search your vault and copy a password without opening Notiq. Off by default.`);

  return (
    <SettingRow label="Quick search hotkey" description={description}>
      <div className="flex items-center gap-2">
        <kbd className={kbd}>{rec ? "Press keys…" : combo}</kbd>
        <Button size="sm" disabled={!loaded || busy} onClick={() => { setErr(null); setRec((r) => !r); }}>
          {rec ? "Cancel" : "Change"}
        </Button>
        {combo !== DEFAULT_QUICK_SEARCH_COMBO && !rec && (
          <Button size="sm" variant="ghost" disabled={busy} aria-label="Reset shortcut"
                  onClick={() => void save(enabled, DEFAULT_QUICK_SEARCH_COMBO)}>
            <RotateCcw size={12} />
          </Button>
        )}
        <Toggle aria-label="Enable quick search hotkey" disabled={!loaded || busy} value={enabled}
                onChange={(v) => void save(v, combo)} />
      </div>
    </SettingRow>
  );
}
