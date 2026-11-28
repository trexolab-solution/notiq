import { useCallback, useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { SettingRow } from "../SettingRow";
import { Select } from "../Select";
import { toast } from "../../../lib/toast";
import {
  CAPTURE_SHIELD_OPTIONS, DEFAULT_CAPTURE_SHIELD, OFF_MINUTES, PAUSED_VALUE, captureShieldOffFor, captureShieldSet,
  captureShieldStatus, offValue, pausedLabel, type CaptureShieldMode, type CaptureShieldStatus,
} from "../../../lib/captureShield";

const START: CaptureShieldStatus = { mode: DEFAULT_CAPTURE_SHIELD, offUntil: null };

/** "Hide from screenshots and screen sharing" (row of the "Locking" group), with "Off for N minutes". */
export function CaptureShieldRow() {
  const [status, setStatus] = useState<CaptureShieldStatus>(START);
  const [now, setNow] = useState(() => Date.now());
  const reload = useCallback(() => {
    captureShieldStatus().then(setStatus).catch(() => { /* keep what is shown */ });
  }, []);
  useEffect(() => { reload(); }, [reload]);
  // The backend ends a timed period by itself and says so; the clock below keeps the "min left" text current.
  useEffect(() => {
    let off: (() => void) | undefined;
    void listen("capture-shield-changed", reload).then((fn) => { off = fn; });
    return () => off?.();
  }, [reload]);
  const paused = status.offUntil !== null && status.offUntil > now;
  useEffect(() => {
    if (!paused) return;
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, [paused]);
  useEffect(() => {
    if (status.offUntil !== null && status.offUntil <= now) reload(); // ended while the page was open
  }, [status.offUntil, now, reload]);

  const options = useMemo(() => [
    ...CAPTURE_SHIELD_OPTIONS,
    ...OFF_MINUTES.map((m) => ({ value: offValue(m), label: `Off for ${m} minutes` })),
    ...(paused ? [{ value: PAUSED_VALUE, label: pausedLabel(status.offUntil!, now) }] : []),
  ], [paused, status.offUntil, now]);

  const failed = () => { toast.error("Could not change this setting"); reload(); };
  const change = (v: string) => {
    if (v === PAUSED_VALUE) return;
    const minutes = OFF_MINUTES.find((m) => offValue(m) === v);
    if (minutes) {
      setNow(Date.now());
      captureShieldOffFor(minutes)
        .then(() => { reload(); toast.info(`Screenshots and screen sharing can see Notiq for ${minutes} minutes`); })
        .catch(failed);
      return;
    }
    const mode = v as CaptureShieldMode;
    setStatus({ mode, offUntil: null });
    captureShieldSet(mode).catch(failed);
  };

  return (
    <SettingRow
      id="vault.locking.capture-shield"
      label="Hide from screenshots and screen sharing"
      description="Keeps Notiq out of screenshots, screen recordings and screen sharing. While it is on, your own screen share or recording shows a black window. “Off for…” turns this off for a while, for example to share your screen; then it comes back on by itself (also after a restart)."
      keywords={["screenshot", "screen share", "screen recording", "capture", "privacy", "black window", "hide window", "teams", "zoom", "obs", "temporary", "minutes", "timer", "off for", "pause"]}
      modified={status.mode !== DEFAULT_CAPTURE_SHIELD || paused}
      onReset={() => change(DEFAULT_CAPTURE_SHIELD)}
    >
      <Select
        aria-label="Hide from screenshots and screen sharing"
        value={paused ? PAUSED_VALUE : status.mode}
        onChange={change}
        options={options}
      />
    </SettingRow>
  );
}
