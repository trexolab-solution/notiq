import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { SettingsBlock } from "../SettingsGroup";
import { Button } from "../Button";
import { Tooltip } from "../Tooltip";
import { BusyIcon, InlineLoading, busyIconProps } from "../Loading";
import { syncErrorMessage, syncStorageQuota, type StorageQuota, type SyncStatus } from "../../../lib/vaultSync";
import { isDriveFull } from "../../../lib/syncSurfaces";
import { describeStorage, formatStorage } from "../../../lib/driveStorage";
import { SYNC_INDEX } from "./syncIndex";

const META = SYNC_INDEX.find((x) => x.id === "vault.sync.storage");
const LABEL = "Google Drive storage";
const KEYWORDS = [...(META?.keywords ?? []), META?.description ?? ""];

const BAR_COLOR = {
  ok: "bg-[var(--color-primary)]",
  warning: "bg-[var(--color-warning)]",
  critical: "bg-[var(--color-danger)]",
  full: "bg-[var(--color-danger)]",
} as const;

const NOTICE = {
  warning: "Your Google storage is almost full.",
  critical: "Very little space is left. Sync stops uploading when your storage is full.",
  full: "Your Google storage is full. Sync can't upload changes until you free up space or get more storage.",
} as const;

/** Settings → Vault → Sync: the connected account's Google storage. Mount it only while connected. */
export function DriveStorageBlock({ status }: { status: SyncStatus }) {
  const [quota, setQuota] = useState<StorageQuota | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Only the newest request may update the view. */
  const latest = useRef(0);
  const signedOut = status.state === "authNeeded";
  const reportedFull = isDriveFull(status.lastError);

  const load = useCallback(async () => {
    const id = ++latest.current;
    setBusy(true);
    try {
      const q = await syncStorageQuota();
      if (id !== latest.current) return;
      if (typeof q?.usage !== "number") throw "Google Drive didn't report the storage";
      setQuota(q);
      setError(null);
    } catch (e) {
      if (id === latest.current) setError(syncErrorMessage(e));
    } finally {
      if (id === latest.current) setBusy(false);
    }
  }, []);

  // On open, after reconnecting, and when a sync starts or stops reporting a full Drive.
  useEffect(() => {
    if (!signedOut) void load();
    return () => { latest.current++; };
  }, [load, signedOut, reportedFull]);

  const view = quota ? describeStorage(quota) : null;
  const refresh = busyIconProps(busy, "Refresh storage", "Checking storage…");

  return (
    <SettingsBlock id="vault.sync.storage" label={LABEL} keywords={KEYWORDS}>
      <div className="flex flex-col gap-2" aria-busy={busy}>
        <div className="flex items-center justify-between gap-2">
          <span className="setting-row-label">{LABEL}</span>
          {!signedOut && (
            <Tooltip content={refresh.tooltip}>
              <Button className="settings-btn" size="sm" disabled={busy}
                      aria-label={refresh["aria-label"]} aria-busy={refresh["aria-busy"]}
                      icon={<BusyIcon icon={RefreshCw} busy={busy} spinSelf size={12} />}
                      onClick={() => void load()} />
            </Tooltip>
          )}
        </div>

        {signedOut ? (
          <p className="text-xs text-[var(--color-text-muted)]">Reconnect to Google to see your storage.</p>
        ) : !quota || !view ? (
          error && !busy ? (
            <div className="flex items-center gap-2">
              <p className="flex-1 text-xs text-[var(--color-text-muted)]">Couldn't check storage: {error}</p>
              <Button className="settings-btn" size="sm" onClick={() => void load()}>Retry</Button>
            </div>
          ) : (
            <InlineLoading label="Checking storage…" />
          )
        ) : (
          <>
            <div className="flex items-baseline justify-between gap-3 flex-wrap">
              <span className="text-sm">{view.summary}</span>
              <span className="text-xs text-[var(--color-text-muted)]">{view.free}</span>
            </div>
            {view.percent != null && (
              <div className="h-2 rounded-full overflow-hidden bg-[var(--color-bg-tertiary)]" role="meter"
                   aria-label="Google storage used" aria-valuemin={0} aria-valuemax={100}
                   aria-valuenow={view.percent} aria-valuetext={`${view.summary}, ${view.free}`}>
                {/* A sliver stays visible when only a little is used. */}
                <div className={`h-full rounded-full ${BAR_COLOR[view.level]}`}
                     style={{ width: `${view.percent}%`, minWidth: quota.usage > 0 ? 4 : 0 }} />
              </div>
            )}
            {view.level !== "ok" && (
              <p role="status" className={`text-xs ${view.level === "warning" ? "text-[var(--color-warning)]" : "text-[var(--color-danger)]"}`}>
                {NOTICE[view.level]}
              </p>
            )}
            <p className="text-[11px] text-[var(--color-text-muted)]">
              Drive files {formatStorage(quota.usageInDrive)}
              {quota.usageInDriveTrash > 0 && ` (${formatStorage(quota.usageInDriveTrash)} in trash)`}
              . Google storage is shared with Gmail and Photos.
            </p>
            {error && (
              <div className="flex items-center gap-2">
                <p className="flex-1 text-[11px] text-[var(--color-text-muted)]">Couldn't refresh, showing earlier numbers: {error}</p>
                <Button className="settings-btn" size="sm" disabled={busy} onClick={() => void load()}>Retry</Button>
              </div>
            )}
          </>
        )}
      </div>
    </SettingsBlock>
  );
}
