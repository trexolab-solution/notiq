import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Check, Copy, ExternalLink, Folder, QrCode as QrIcon, Smartphone, X } from "lucide-react";
import { Tooltip } from "../ui/Tooltip";
import { QrCode } from "../ui/QrCode";
import { Spinner } from "../ui/Loading";
import { toast } from "../../lib/toast";
import { isTauri } from "../../lib/tauriWindow";
import { useAppStore } from "../../store";
import { useClickOutside } from "../../hooks/useClickOutside";
import { useEscapeKey } from "../../hooks/useEscapeKey";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { getQrWithLogin, getShareFolder, shareErrorMessage, shareLink, shareMode, useShareStore } from "../../lib/webdavShare";

/**
 * Status-bar quick access for "Phone Share" (Settings: "Share files to phone"): a button that shows whether sharing is on, and a small panel in
 * the same style as the Vault Sync panel to start / stop it, open the share in this computer's browser, copy its
 * address or jump to the QR code.
 */
export function ShareIndicator() {
  const { info, busy, upload, manage, refresh, start, stop } = useShareStore();
  const [open, setOpen] = useState(false);
  /** The QR code is shown inside the panel (opened from the QR button). */
  const [qr, setQr] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const { copied, copy } = useCopyToClipboard();
  useClickOutside(box, () => setOpen(false), open);
  useEscapeKey(() => setOpen(false), open);
  useEffect(() => { if (!open || !info) setQr(false); }, [open, info]);
  useEffect(() => { void refresh(); }, [refresh]);
  if (!isTauri) return null;

  const folder = getShareFolder();
  const settings = (id: string) => { setOpen(false); useAppStore.getState().openSettings("vault", id); };
  const toggle = async () => {
    try { if (info) await stop(); else await start(folder); } catch (e) { toast.error(shareErrorMessage(e)); }
  };
  const on = !!info;
  const mode = info ? shareMode(info.upload, info.manage) : shareMode(upload, manage);

  return (
    <div ref={box} className="relative flex items-center">
      <Tooltip content={on ? "Phone Share is on. Click for the address and QR code." : "Phone Share: open files on your phone"} disabled={open}>
        <button type="button" className={`status-sync ${on ? "status-sync--synced" : "status-sync--off"}`} aria-haspopup="dialog" aria-expanded={open}
                aria-label={on ? "Phone Share, on: open the panel" : "Phone Share, off: open the panel"} onClick={() => { setOpen((o) => !o); void refresh(); }}>
          <span className="relative inline-flex" aria-hidden>
            <Smartphone size={11} />
            {on && <span className="absolute -right-[3px] -top-[2px] h-[5px] w-[5px] rounded-full bg-[var(--color-success)] ring-1 ring-[var(--color-bg-secondary)]" />}
          </span>
          <span>Phone Share</span>
        </button>
      </Tooltip>

      {open && (
        <div role="dialog" aria-label="Phone Share" className="sync-pop" style={{ position: "absolute", bottom: "calc(100% + 6px)", right: 0, width: 292 }}>
          <div className="flex items-center gap-2 px-3 pt-2.5 pb-2">
            <Smartphone size={14} className="shrink-0 text-[var(--color-text-muted)]" aria-hidden />
            <h2 className="flex-1 m-0 text-[12.5px] font-semibold">Phone Share</h2>
            <span className={`sync-pop__badge ${on ? "sync-pop__badge--ok" : "sync-pop__badge--muted"}`}>{on ? "On" : "Off"}</span>
            <button type="button" className="vt-icon-btn" aria-label="Close" onClick={() => setOpen(false)}><X size={13} /></button>
          </div>

          <div className="flex flex-col gap-2.5 px-3 pb-3">
            {info ? (
              <>
                <div className="flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] pl-2.5 pr-1">
                  <code className="min-w-0 flex-1 truncate py-1.5 text-[12px] select-all" title={info.url}>{info.url}</code>
                  <button type="button" className="vt-icon-btn" aria-label={copied ? "Address copied" : "Copy address"} title="Copy address" onClick={() => void copy(info.url)}>
                    {copied ? <Check size={13} className="text-[var(--color-success)]" /> : <Copy size={13} />}
                  </button>
                </div>
                <div className="flex items-center gap-1.5 text-[11.5px] text-[var(--color-text-muted)]" title={info.folder}>
                  <Folder size={12} className="shrink-0" aria-hidden />
                  <span className="min-w-0 truncate">{info.folder}</span>
                  <span className="shrink-0" aria-hidden>·</span>
                  <span className="shrink-0">{mode}</span>
                </div>
                <div className="flex gap-1.5">
                  <button type="button" className="sync-pop__btn sync-pop__btn--primary flex-1 justify-center" onClick={() => { void openUrl(shareLink(info)).catch(console.error); setOpen(false); }}>
                    <ExternalLink size={12} aria-hidden />Open in browser
                  </button>
                  <button type="button" className="sync-pop__btn justify-center" aria-pressed={qr} onClick={() => setQr((v) => !v)}>
                    <QrIcon size={12} aria-hidden />{qr ? "Hide QR" : "QR code"}
                  </button>
                </div>
                {qr && (
                  <div className="flex flex-col items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] p-3" data-testid="share-qr">
                    <QrCode value={getQrWithLogin() ? shareLink(info) : info.url} size={176} label="QR code to open the share on a phone" />
                    <span className="text-center text-[11px] leading-snug text-[var(--color-text-muted)]">
                      Scan with the phone's camera.{getQrWithLogin() ? "" : <> It asks for the user name <b className="font-medium text-[var(--color-text)]">{info.username}</b> and the password.</>}
                    </span>
                  </div>
                )}
              </>
            ) : (
              <>
                <p className="m-0 text-[11.5px] leading-relaxed text-[var(--color-text-muted)]">
                  Share a folder of this computer with a phone on the same Wi-Fi. {mode === "Read-only" ? "The phone can look and download." : mode === "Full access" ? "The phone can look, download, upload, rename, move and delete." : "The phone can look, download and upload."}
                </p>
                <div className="flex items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] px-2.5 py-1.5 text-[12px]" title={folder}>
                  <Folder size={13} className="shrink-0 text-[var(--color-text-muted)]" aria-hidden />
                  <span className={`min-w-0 flex-1 truncate ${folder ? "" : "text-[var(--color-text-muted)]"}`}>{folder || "No folder picked yet"}</span>
                  <button type="button" className="sync-pop__link shrink-0" onClick={() => settings("vault.share.folder")}>{folder ? "Change" : "Choose"}</button>
                </div>
                <button type="button" className="sync-pop__btn sync-pop__btn--primary w-full justify-center" disabled={!folder || busy} onClick={() => void toggle()}>
                  {busy ? <Spinner size={12} /> : null}{busy ? "Starting…" : "Start sharing"}
                </button>
              </>
            )}

            <div className="flex items-center border-t border-[var(--color-border)] pt-1.5">
              <button type="button" className="sync-pop__link" style={{ marginLeft: 0 }} onClick={() => settings("vault.share.login")}>Settings</button>
              {info && (
                <button type="button" className="sync-pop__link text-[var(--color-danger)]" disabled={busy} onClick={() => void toggle()}>
                  {busy ? "Stopping…" : "Stop sharing"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
