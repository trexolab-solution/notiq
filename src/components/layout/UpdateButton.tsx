import React from "react";
import { Download, RotateCw, Loader2 } from "lucide-react";
import { useUpdater } from "../../hooks/useUpdater";
import { updater } from "../../lib/updater";
import { Tooltip } from "../ui/Tooltip";

/**
 * Zed-style "update available" pill in the topbar. Hidden unless an update is
 * available / downloading / installed-and-ready. Clicking opens the update
 * dialog (or restarts once the update is installed).
 */
export const UpdateButton = React.memo(function UpdateButton() {
  const { status, version, progress } = useUpdater();

  if (status !== "available" && status !== "downloading" && status !== "ready") return null;

  const pct = Math.round(progress * 100);
  const label =
    status === "downloading" ? `Updating… ${pct}%` :
    status === "ready"       ? "Restart to update" :
    /* available */            "Update";
  const tip =
    status === "downloading" ? "Downloading update…" :
    status === "ready"       ? "Update installed — click to restart" :
    /* available */            `Update available${version ? ` — v${version}` : ""}`;

  const onClick = () => {
    if (status === "available") updater.openDialog();
    else if (status === "ready") void updater.relaunchApp();
  };

  return (
    <Tooltip content={tip}>
      <button
        className="update-pill"
        aria-label={tip}
        onClick={onClick}
        disabled={status === "downloading"}
      >
        {status === "downloading"
          ? <Loader2 size={12} className="animate-spin" />
          : status === "ready"
            ? <RotateCw size={12} />
            : <Download size={12} />}
        <span>{label}</span>
      </button>
    </Tooltip>
  );
});
