import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Check, Copy, Eye, EyeOff } from "lucide-react";
import { SettingRow } from "../SettingRow";
import { SettingsGroup } from "../SettingsGroup";
import { Toggle } from "../Toggle";
import { Button } from "../Button";
import { QrCode } from "../QrCode";
import { WebdavSignInDialog } from "./WebdavSignInDialog";
import { toast } from "../../../lib/toast";
import { useCopyToClipboard } from "../../../hooks/useCopyToClipboard";
import {
  DEFAULT_SHARE_USER, getQrWithLogin, getShareFolder, setQrWithLogin, setShareFolder, shareErrorMessage, shareLink, useShareStore,
} from "../../../lib/webdavShare";

const KW = ["webdav", "phone", "mobile", "share", "local network", "wifi", "lan", "files", "qr"];

/** One value the phone needs: label, the value (the password can be hidden) and a Copy button. */
function Field({ label, value, secret = false }: { label: string; value: string; secret?: boolean }) {
  const { copied, copy } = useCopyToClipboard();
  const [shown, setShown] = useState(false);
  return (
    <div className="flex items-center gap-2 text-[13px]">
      <span className="w-[72px] shrink-0 text-[var(--color-text-muted)]">{label}</span>
      <code className="flex-1 min-w-0 truncate select-all rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-[12.5px]">
        {secret && !shown ? "•".repeat(Math.min(value.length, 16)) : value}
      </code>
      {secret && (
        <Button size="sm" variant="ghost" aria-label={shown ? "Hide password" : "Show password"} icon={shown ? <EyeOff size={13} /> : <Eye size={13} />}
                onClick={() => setShown((s) => !s)} />
      )}
      <Button size="sm" variant="ghost" aria-label={`Copy ${label.toLowerCase()}`} icon={copied ? <Check size={13} /> : <Copy size={13} />}
              onClick={() => void copy(value)}>{copied ? "Copied" : "Copy"}</Button>
    </div>
  );
}

/** Share one folder of this computer, read-only, with a phone on the same Wi-Fi (Settings → Vault). */
export function WebdavShareSettings() {
  const [folder, setFolder] = useState(getShareFolder);
  const [qrLogin, setQrLogin] = useState(getQrWithLogin);
  const [editing, setEditing] = useState(false);
  const { info, busy, user, pass, refresh, setLogin, start, stop, restart } = useShareStore();

  useEffect(() => { void refresh(); }, [refresh]);

  const choose = async () => {
    const picked = await open({ directory: true, multiple: false, defaultPath: folder || undefined });
    if (typeof picked === "string") { setFolder(picked); setShareFolder(picked); }
  };

  const toggle = async (on: boolean) => {
    try { if (on) await start(folder); else await stop(); } catch (e) { toast.error(shareErrorMessage(e)); }
  };

  /** The dialog's Save / Update: stores the sign-in, and when sharing is on restarts it so the new one applies. */
  const save = async (u: string, p: string) => {
    setLogin(u, p);
    setEditing(false);
    if (!info) { toast.success("Sign-in saved."); return; }
    try { await restart(folder); toast.success("Sharing restarted. Phones must sign in again."); } catch (e) { toast.error(shareErrorMessage(e)); }
  };

  const shownUser = info?.username ?? (user || DEFAULT_SHARE_USER);
  const shownPass = info ? "•".repeat(Math.min(info.password.length, 12)) : pass ? "•".repeat(Math.min(pass.length, 12)) : "random";

  return (
    <SettingsGroup title="Share files to phone"
                   description="Lets a phone on the same Wi-Fi browse and download one folder of this computer, using any WebDAV app. Read-only: nothing can be changed from the phone.">
      <SettingRow id="vault.share.enabled" label="Share this folder" keywords={[...KW, "server", "turn on"]}
                  description={info ? undefined : "Turns on while Notiq is open. The connection isn't encrypted, so use a network you trust."}>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1.5 text-xs text-[var(--color-text-muted)]" aria-live="polite">
            <span aria-hidden className={`h-2 w-2 rounded-full ${info ? "bg-[var(--color-success)]" : "bg-[var(--color-border)]"}`} />
            {busy ? "Working…" : info ? "Sharing" : "Off"}
          </span>
          <Toggle aria-label="Share this folder to phone" value={!!info} disabled={busy || (!info && !folder)} onChange={(v) => void toggle(v)} />
        </div>
      </SettingRow>

      <SettingRow id="vault.share.folder" label="Folder to share" description={folder || "No folder picked yet."} keywords={[...KW, "folder", "directory", "choose"]}>
        <Button size="sm" variant="ghost" disabled={!!info || busy} onClick={() => void choose()}>{folder ? "Change…" : "Choose…"}</Button>
      </SettingRow>

      <SettingRow id="vault.share.login" label="Sign-in" keywords={[...KW, "user name", "username", "password", "login", "custom", "change", "update"]}
                  description={`User name ${shownUser} · password ${shownPass}`}>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(true)}>Edit…</Button>
      </SettingRow>

      <SettingRow id="vault.share.qr-login" label="Put the password in the QR code"
                  description="Off: after scanning, the phone asks for the sign-in. On: it signs in without asking, but anyone who can see the QR code can sign in."
                  keywords={[...KW, "password", "ask", "prompt", "scan"]}>
        <Toggle aria-label="Put the password in the QR code" value={qrLogin} onChange={(v) => { setQrLogin(v); setQrWithLogin(v); }} />
      </SettingRow>

      {info && (
        <div className="p-4" data-testid="webdav-share-info">
          <div className="flex flex-col gap-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-tertiary)]/40 p-4 sm:flex-row">
            <div className="flex shrink-0 flex-col items-center gap-1.5">
              <QrCode value={qrLogin ? shareLink(info) : info.url} label={qrLogin ? "QR code with the address and password" : "QR code with the address"} />
              <span className="text-[11px] text-[var(--color-text-muted)]">Scan with the phone's camera</span>
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-2.5">
              <div>
                <h4 className="text-[13px] font-semibold">Connect your phone</h4>
                <p className="mt-0.5 text-xs leading-relaxed text-[var(--color-text-muted)]">
                  Join the same Wi-Fi, then scan the code to browse in the browser{qrLogin ? ", already signed in" : ""}. Or add a WebDAV server in an app (Solid Explorer, Documents, Files, FolderSync…) with these details.
                </p>
              </div>
              <Field label="Address" value={info.url} />
              <Field label="User name" value={info.username} />
              <Field label="Password" value={info.password} secret />
              <p className="text-[11px] text-[var(--color-text-muted)]">Windows may ask to allow Notiq through its firewall: allow it on private networks.</p>
            </div>
          </div>
        </div>
      )}

      {editing && <WebdavSignInDialog user={info?.username ?? user} pass={info?.password ?? pass} running={!!info} onSave={(u, p) => void save(u, p)} onClose={() => setEditing(false)} />}
    </SettingsGroup>
  );
}
