import { useState } from "react";
import { SettingRow } from "../SettingRow";
import { Toggle } from "../Toggle";
import {
  AUTOHIDE_OPTIONS, getAutoHideSeconds, getLockOnSession, setAutoHideSeconds, setLockOnSession,
} from "../../../lib/vaultPrefs";

const sel = "text-xs rounded-md px-2 py-1 bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] outline-none";

/** Lock-on-session-lock toggle and the revealed-secret auto-hide timeout. */
export function SessionLockRow() {
  const [lock, setLock] = useState(getLockOnSession);
  const [secs, setSecs] = useState(getAutoHideSeconds);
  return (
    <>
      <SettingRow
        label="Lock when Windows locks or sleeps"
        description="Locks the vault when you lock your PC (Win+L), it goes to sleep, or a remote session disconnects."
      >
        <Toggle aria-label="Lock vault when the session locks" value={lock} onChange={(v) => { setLock(v); setLockOnSession(v); }} />
      </SettingRow>
      <SettingRow
        label="Auto-hide revealed secrets"
        description="Hides a shown password or key again after this time, or as soon as the window loses focus."
      >
        <select aria-label="Auto-hide revealed secrets" className={sel} value={secs}
                onChange={(e) => { const n = Number(e.target.value); setSecs(n); setAutoHideSeconds(n); }}>
          {AUTOHIDE_OPTIONS.map((n) => <option key={n} value={n}>{n === 0 ? "Never" : `${n} seconds`}</option>)}
        </select>
      </SettingRow>
    </>
  );
}
