import { useCallback, useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { SettingRow } from "../SettingRow";
import { Select } from "../Select";
import { toast } from "../../../lib/toast";
import {
  CAPTURE_SHIELD_OPTIONS, DEFAULT_CAPTURE_SHIELD, HIDING_VALUE, HIDE_MINUTES, captureShieldHideFor, captureShieldSet,
  captureShieldStatus, hideValue, hidingLabel, type CaptureShieldMode, type CaptureShieldStatus,
} from "../../../lib/captureShield";

const START: CaptureShieldStatus = { mode: DEFAULT_CAPTURE_SHIELD, hiddenUntil: null };

/** "Hide from screenshots and screen sharing" (row of the "Locking" group), with "Hide for N minutes". */
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
  const hiding = status.hiddenUntil !== null && status.hiddenUntil > now;
  useEffect(() => {
    if (!hiding) return;
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, [hiding]);
  useEffect(() => {
    if (status.hiddenUntil !== null && status.hiddenUntil <= now) reload(); // ended while the page was open
  }, [status.hiddenUntil, now, reload]);

  const options = useMemo(() => [
    ...CAPTURE_SHIELD_OPTIONS,
    ...HIDE_MINUTES.map((m) => ({ value: hideValue(m), label: `Hide for ${m} minutes` })),
    ...(hiding ? [{ value: HIDING_VALUE, label: hidingLabel(status.hiddenUntil!, now) }] : []),
  ], [hiding, status.hiddenUntil, now]);

  const failed = () => { toast.error("Could not change this setting"); reload(); };
  const change = (v: string) => {
    if (v === HIDING_VALUE) return;
    const minutes = HIDE_MINUTES.find((m) => hideValue(m) === v);
    if (minutes) {
      setNow(Date.now());
      setStatus((s) => ({ ...s, hiddenUntil: Date.now() + minutes * 60_000 }));
      captureShieldHideFor(minutes)
        .then(() => toast.info(`Notiq is hidden from screenshots and screen sharing for ${minutes} minutes`))
        .catch(failed);
      return;
    }
    const mode = v as CaptureShieldMode;
    setStatus({ mode, hiddenUntil: null });
    captureShieldSet(mode).catch(failed);
  };

  return (
    <SettingRow
      id="vault.locking.capture-shield"
      label="Hide from screenshots and screen sharing"
      description="Keeps Notiq out of screenshots, screen recordings and screen sharing. While it is on, your own screen share or recording shows a black window. “Hide for…” hides it for a while, then your saved choice applies again by itself."
      keywords={["screenshot", "screen share", "screen recording", "capture", "privacy", "black window", "hide window", "teams", "zoom", "obs", "temporary", "minutes", "timer", "hide for"]}
      modified={status.mode !== DEFAULT_CAPTURE_SHIELD || hiding}
      onReset={() => change(DEFAULT_CAPTURE_SHIELD)}
    >
      <Select
        aria-label="Hide from screenshots and screen sharing"
        value={hiding ? HIDING_VALUE : status.mode}
        onChange={change}
        options={options}
      />
    </SettingRow>
  );
}
