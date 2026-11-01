import { useEffect, useState } from "react";
import { SettingRow } from "../SettingRow";
import { Select } from "../Select";
import { toast } from "../../../lib/toast";
import {
  CAPTURE_SHIELD_OPTIONS, DEFAULT_CAPTURE_SHIELD, captureShieldGet, captureShieldSet, type CaptureShieldMode,
} from "../../../lib/captureShield";

/** "Hide from screenshots and screen sharing" (row of the "Locking" group). */
export function CaptureShieldRow() {
  const [mode, setMode] = useState<CaptureShieldMode>(DEFAULT_CAPTURE_SHIELD);
  useEffect(() => { captureShieldGet().then(setMode).catch(() => { /* keep the default */ }); }, []);
  const change = (m: CaptureShieldMode) => {
    const prev = mode;
    setMode(m);
    captureShieldSet(m).catch(() => { setMode(prev); toast.error("Could not change this setting"); });
  };
  return (
    <SettingRow
      id="vault.locking.capture-shield"
      label="Hide from screenshots and screen sharing"
      description="Keeps Notiq out of screenshots, screen recordings and screen sharing. While it is on, your own screen share or recording shows a black window."
      keywords={["screenshot", "screen share", "screen recording", "capture", "privacy", "black window", "hide window", "teams", "zoom", "obs"]}
      modified={mode !== DEFAULT_CAPTURE_SHIELD}
      onReset={() => change(DEFAULT_CAPTURE_SHIELD)}
    >
      <Select
        aria-label="Hide from screenshots and screen sharing"
        value={mode}
        onChange={(v) => change(v as CaptureShieldMode)}
        options={CAPTURE_SHIELD_OPTIONS}
      />
    </SettingRow>
  );
}
