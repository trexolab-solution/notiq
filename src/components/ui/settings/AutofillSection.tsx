import React, { useCallback, useEffect, useState } from "react";
import { Copy, FolderOpen, Globe, RefreshCw, Wrench } from "lucide-react";
import { SettingRow } from "../SettingRow";
import { SettingsBlock } from "../SettingsGroup";
import { Button } from "../Button";
import { toast } from "../../../lib/toast";
import { isTauri } from "../../../lib/tauriWindow";
import { useCopyToClipboard } from "../../../hooks/useCopyToClipboard";
import {
  autofillExtensionDir, autofillOpenBrowserExtensions, autofillOpenExtensionDir, autofillRepair, autofillStatus,
  browserRegState, BROWSER_REG_LABEL, type AutofillStatus, type BrowserRegState, type ExtensionBrowser,
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
  const [extDir, setExtDir] = useState<string | null | undefined>(undefined); // undefined = still loading
  const { copied, copy } = useCopyToClipboard();

  useEffect(() => {
    if (!isTauri) return;
    autofillExtensionDir().then(setExtDir).catch(() => setExtDir(null));
  }, []);

  const run = async (what: () => Promise<void>) => {
    try { await what(); } catch (e) { toast.error(String(e)); }
  };
  const openBrowser = (b: ExtensionBrowser) => run(() => autofillOpenBrowserExtensions(b));

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
    <>
      <SettingsBlock
        id="vault.autofill.install"
        label="Install the browser extension"
        description="Load the Notiq extension into Edge, Chrome or Brave to fill logins from your vault."
        keywords={["extension", "chrome", "edge", "brave", "firefox", "developer mode", "load unpacked", "autofill", "browser"]}
      >
        <div className="rounded-lg border border-[var(--color-border)] p-3 flex flex-col gap-2 bg-[var(--color-bg-tertiary)]">
          <div className="text-sm font-medium text-[var(--color-text)]">Install the browser extension</div>
          <ol className="list-decimal pl-5 text-xs leading-relaxed text-[var(--color-text-muted)] flex flex-col gap-0.5">
            <li>Open your browser's extensions page (buttons below) and turn on <b className="text-[var(--color-text)]">Developer mode</b>.</li>
            <li>Click <b className="text-[var(--color-text)]">Load unpacked</b> and choose the folder shown here.</li>
            <li>Come back and press Refresh below: "Extension last seen" shows when it connected.</li>
          </ol>
          {extDir === null ? (
            <p className="text-xs text-[var(--color-warning,#d29922)]">
              The extension files weren't found next to this installation. Download <code>notiq-autofill-…-chrome.zip</code> from the
              Notiq release page, unzip it and load that folder instead.
            </p>
          ) : (
            <div className="flex items-center gap-2 rounded-md px-2 py-1.5 bg-[var(--color-bg)] border border-[var(--color-border)]">
              <code className="flex-1 min-w-0 truncate text-[11px] text-[var(--color-text)]" title={extDir ?? undefined}>{extDir ?? "…"}</code>
              <Button size="sm" variant="ghost" aria-label="Copy folder path" disabled={!extDir}
                      icon={<Copy size={12} />} onClick={() => extDir && void copy(extDir)}>{copied ? "Copied" : "Copy"}</Button>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" icon={<FolderOpen size={12} />} disabled={!extDir} onClick={() => void run(autofillOpenExtensionDir)}>Open folder</Button>
            <Button size="sm" icon={<Globe size={12} />} onClick={() => void openBrowser("edge")}>Edge extensions</Button>
            <Button size="sm" icon={<Globe size={12} />} onClick={() => void openBrowser("chrome")}>Chrome extensions</Button>
            <Button size="sm" icon={<Globe size={12} />} onClick={() => void openBrowser("brave")}>Brave extensions</Button>
          </div>
          <p className="text-[11px] text-[var(--color-text-muted)]">
            After a Notiq update the files in this folder are refreshed; press the reload button on the extension's card in the
            browser to pick them up. Firefox isn't covered by this folder (use the Firefox package from the release page).
          </p>
        </div>
      </SettingsBlock>

      <SettingRow
        id="vault.autofill.connection"
        label="Browser connection"
        keywords={["repair", "native host", "register", "extension", "bridge", "refresh"]}
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

      <SettingsBlock
        id="vault.autofill.status"
        label="Browser registration and status"
        description="Which browsers Notiq is registered with, whether the local bridge is running, and when the extension was last seen."
        keywords={["status", "bridge", "extension last seen", "registered", "last request", "diagnostics"]}
        className="flex flex-col gap-3"
      >
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
        {!status && !err && <p className="text-xs text-[var(--color-text-muted)]">Checking browser status…</p>}
      </SettingsBlock>
    </>
  );
});
