import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Check, Copy, ExternalLink, QrCode, Smartphone } from "lucide-react";
import { Tooltip } from "../ui/Tooltip";
import { Button } from "../ui/Button";
import { toast } from "../../lib/toast";
import { isTauri } from "../../lib/tauriWindow";
import { useAppStore } from "../../store";
import { useClickOutside } from "../../hooks/useClickOutside";
import { useEscapeKey } from "../../hooks/useEscapeKey";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { getShareFolder, shareErrorMessage, shareLink, useShareStore } from "../../lib/webdavShare";

/**
 * Status-bar quick access for "Share files to phone": a button that shows whether sharing is on, and a small panel to
 * start / stop it, open the share in this computer's browser, copy its address or jump to the QR code.
 */
export function ShareIndicator() {
  const { info, busy, refresh, start, stop } = useShareStore();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const { copied, copy } = useCopyToClipboard();
  useClickOutside(box, () => setOpen(false), open);
  useEscapeKey(() => setOpen(false), open);
  useEffect(() => { void refresh(); }, [refresh]);
  if (!isTauri) return null;

  const folder = getShareFolder();
  const settings = (id: string) => { setOpen(false); useAppStore.getState().openSettings("vault", id); };
  const toggle = async () => {
    try { if (info) await stop(); else await start(folder); } catch (e) { toast.error(shareErrorMessage(e)); }
  };
  const label = info ? "Sharing" : "Share";

  return (
    <div ref={box} className="relative flex items-center">
      <Tooltip content={info ? "Sharing files to phone" : "Share files to phone"} disabled={open}>
        <button type="button" className={`status-sync ${info ? "status-sync--synced" : "status-sync--off"}`} aria-haspopup="dialog" aria-expanded={open}
                aria-label={info ? "Sharing files to phone: open the share panel" : "Share files to phone"} onClick={() => { setOpen((o) => !o); void refresh(); }}>
          <Smartphone size={11} />
          <span>{label}</span>
        </button>
      </Tooltip>

      {open && (
        <div role="dialog" aria-label="Share files to phone"
             className="absolute bottom-full right-0 z-50 mb-1.5 w-[300px] rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-3 text-[12px] text-[var(--color-text)] shadow-xl">
          <div className="flex items-center gap-2">
            <span aria-hidden className={`h-2 w-2 rounded-full ${info ? "bg-[var(--color-success)]" : "bg-[var(--color-border)]"}`} />
            <span className="font-semibold">{info ? "Sharing to phone" : "Share files to phone"}</span>
          </div>

          {info ? (
            <>
              <p className="mt-2 text-[var(--color-text-muted)]">Read-only, on this Wi-Fi network.</p>
              <code className="mt-1.5 block truncate rounded-md bg-[var(--color-bg-tertiary)] px-2 py-1.5 select-all">{info.url}</code>
              <p className="mt-1 truncate text-[11px] text-[var(--color-text-muted)]" title={info.folder}>{info.folder}</p>
              <div className="mt-2.5 grid grid-cols-2 gap-1.5">
                <Button size="sm" variant="primary" icon={<ExternalLink size={12} />} onClick={() => { void openUrl(shareLink(info)).catch(console.error); setOpen(false); }}>Open in browser</Button>
                <Button size="sm" variant="ghost" icon={copied ? <Check size={12} /> : <Copy size={12} />} onClick={() => void copy(info.url)}>{copied ? "Copied" : "Copy address"}</Button>
                <Button size="sm" variant="ghost" icon={<QrCode size={12} />} onClick={() => settings("vault.share.enabled")}>QR code</Button>
                <Button size="sm" variant="danger" loading={busy} loadingText="Stopping…" onClick={() => void toggle()}>Stop sharing</Button>
              </div>
            </>
          ) : (
            <>
              <p className="mt-2 text-[var(--color-text-muted)]">
                {folder ? <>Share <span className="text-[var(--color-text)]">{folder}</span> with a phone on this Wi-Fi, read-only.</> : "Pick a folder in Settings first, then start sharing from here."}
              </p>
              <div className="mt-2.5 grid grid-cols-2 gap-1.5">
                {folder
                  ? <Button size="sm" variant="primary" loading={busy} loadingText="Starting…" onClick={() => void toggle()}>Start sharing</Button>
                  : <Button size="sm" variant="primary" onClick={() => settings("vault.share.folder")}>Choose folder</Button>}
                <Button size="sm" variant="ghost" onClick={() => settings("vault.share.login")}>Settings</Button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
