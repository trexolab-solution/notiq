import React, { useCallback, useEffect, useState } from "react";
import { RefreshCw, Wrench } from "lucide-react";
import { SettingRow } from "../SettingRow";
import { Button } from "../Button";
import { SubHeading } from "./SubHeading";
import { toast } from "../../../lib/toast";
import { isTauri } from "../../../lib/tauriWindow";
import {
  autofillRepair, autofillStatus, browserRegState, BROWSER_REG_LABEL, type AutofillStatus, type BrowserRegState,
} from "../../../lib/autofill";

const STATE_COLOR: Record<BrowserRegState, string> = {
  ok: "var(--color-success, #3fb950)",
  missing: "var(--color-text-muted)",
  other_copy: "var(--color-warning, #d29922)",
  outdated: "var(--color-warning, #d29922)",
};

function ago(ms: number | null | undefined): string {
  if (!ms) return "Never (since Notiq started)";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  const when = s < 60 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
  return `${when} · ${new Date(ms).toLocaleTimeString()}`;
}

/** Settings → Browser autofill: native-host registration per browser, bridge health and a Repair button. */
export const AutofillSection = React.memo(function AutofillSection() {
  const [status, setStatus] = useState<AutofillStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!isTauri) return;
    try { setStatus(await autofillStatus()); setErr(null); }
    catch (e) { setErr(String(e)); }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const repair = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const s = await autofillRepair();
      setStatus(s);
      const allOk = s.browsers.filter((b) => b.installed).every((b) => browserRegState(b) === "ok");
      const msg = s.note ?? "Done";
      if (s.is_dev) toast.warning(msg, 9000);
      else if (allOk) toast.success(msg);
      else toast.warning(msg, 7000);
    } catch (e) {
      toast.error(`Repair failed: ${String(e)}`);
    } finally {
      setBusy(false);
      void refresh();
    }
  };

  const browsers = status?.browsers ?? [];
  const shown = browsers.filter((b) => b.installed || b.registered);

  return (
    <div className="flex flex-col gap-3">
      <SubHeading>Browser autofill</SubHeading>

      <SettingRow
        label="Browser connection"
        description={
          status && !status.supported
            ? "Browser autofill isn't available on this platform yet."
            : "Lets the Notiq browser extension reach this app. Repair re-registers Notiq with every installed browser."
        }
      >
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={() => void refresh()} aria-label="Refresh status"><RefreshCw size={12} /></Button>
          <Button size="sm" icon={<Wrench size={12} />} disabled={busy || !status?.supported} onClick={() => void repair()}>
            {busy ? "Repairing…" : "Repair"}
          </Button>
        </div>
      </SettingRow>

      {err && <p className="text-xs text-[var(--color-danger)]">{err}</p>}

      {status?.supported && (
        <div className="rounded-lg border border-[var(--color-border)] overflow-hidden">
          <table className="w-full text-xs">
            <tbody>
              {shown.length === 0 && (
                <tr><td className="px-3 py-2 text-[var(--color-text-muted)]">No supported browser found.</td></tr>
              )}
              {shown.map((b) => {
                const st = browserRegState(b);
                return (
                  <tr key={b.name} className="border-b last:border-b-0 border-[var(--color-border)]">
                    <td className="px-3 py-1.5 font-medium text-[var(--color-text)] w-28">
                      {b.name}
                      {!b.installed && <span className="ml-1 font-normal text-[var(--color-text-muted)]">(not found)</span>}
                    </td>
                    <td className="px-3 py-1.5" style={{ color: STATE_COLOR[st] }} title={b.manifest_path ?? undefined}>
                      {BROWSER_REG_LABEL[st]}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {status && (
        <div className="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
          <div>Local bridge: <span className="text-[var(--color-text)]">{status.ipc_ok ? "Running" : "Not running"}</span></div>
          <div>Extension last seen: <span className="text-[var(--color-text)]">{ago(status.extension_last_seen_ms)}</span></div>
          <div>
            Last request:{" "}
            <span className="text-[var(--color-text)]">
              {status.last_request ? `${status.last_request.host} → ${status.last_request.outcome} (${ago(status.last_request.at_ms)})` : "None"}
            </span>
          </div>
          {status.is_dev && (
            <div className="text-[var(--color-warning,#d29922)]">
              Development build: it never registers on its own. Repair would point your browsers at this dev exe
              ({status.native_host_exe}) instead of the installed Notiq.
            </div>
          )}
        </div>
      )}
    </div>
  );
});
