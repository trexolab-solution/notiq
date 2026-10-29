import { useState } from "react";
import { SettingRow } from "../SettingRow";
import { Toggle } from "../Toggle";
import { Select } from "../Select";
import {
  AUTOHIDE_OPTIONS, DEFAULT_AUTOHIDE_SECONDS, getAutoHideSeconds, getLockOnSession, setAutoHideSeconds, setLockOnSession,
} from "../../../lib/vaultPrefs";

/** Lock-on-session-lock toggle and the revealed-secret auto-hide timeout (rows of the "Locking" group). */
export function SessionLockRow() {
  const [lock, setLock] = useState(getLockOnSession);
  const [secs, setSecs] = useState(getAutoHideSeconds);
  const changeSecs = (n: number) => { setSecs(n); setAutoHideSeconds(n); };
  return (
    <>
      <SettingRow
        id="vault.locking.on-session-lock"
        label="Lock when Windows locks or sleeps"
        description="Locks the vault when you lock your PC (Win+L), it goes to sleep, or a remote session disconnects."
        keywords={["session", "sleep", "suspend", "win+l", "remote desktop", "windows lock"]}
        modified={!lock}
        onReset={() => { setLock(true); setLockOnSession(true); }}
      >
        <Toggle aria-label="Lock vault when the session locks" value={lock} onChange={(v) => { setLock(v); setLockOnSession(v); }} />
      </SettingRow>
      <SettingRow
        id="vault.locking.auto-hide"
        label="Auto-hide revealed secrets"
        description="Hides a shown password or key again after this time, or as soon as the window loses focus."
        keywords={["reveal", "show password", "hide", "timeout"]}
        modified={secs !== DEFAULT_AUTOHIDE_SECONDS}
        onReset={() => changeSecs(DEFAULT_AUTOHIDE_SECONDS)}
      >
        <Select
          aria-label="Auto-hide revealed secrets"
          value={String(secs)}
          onChange={(v) => changeSecs(Number(v))}
          options={AUTOHIDE_OPTIONS.map((n) => ({ value: String(n), label: n === 0 ? "Never" : `${n} seconds` }))}
        />
      </SettingRow>
    </>
  );
}
