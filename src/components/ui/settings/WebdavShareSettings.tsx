import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Check, Copy, Eye, EyeOff, FolderOpen } from "lucide-react";
import { SettingRow } from "../SettingRow";
import { SettingsGroup } from "../SettingsGroup";
import { Toggle } from "../Toggle";
import { Button } from "../Button";
import { QrCode } from "../QrCode";
import { WebdavSignInDialog } from "./WebdavSignInDialog";
import { toast } from "../../../lib/toast";
import { useCopyToClipboard } from "../../../hooks/useCopyToClipboard";
import {
  DEFAULT_SHARE_USER, getQrWithLogin, getShareFolder, setQrWithLogin, setShareFolder, shareErrorMessage, shareLink, shareMode, useShareStore,
} from "../../../lib/webdavShare";
import type { SettingMeta } from "../../../lib/settingsIndex";

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

/** The WebDAV section (Settings → WebDAV): share one folder of this computer with a phone on the same Wi-Fi. */
export function WebdavShareSettings() {
  const [folder, setFolder] = useState(getShareFolder);
  const [qrLogin, setQrLogin] = useState(getQrWithLogin);
  const [editing, setEditing] = useState(false);
  const { info, busy, user, pass, upload, manage, https, refresh, setLogin, setUpload, setManage, setHttps, start, stop, restart } = useShareStore();

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

  /** Allows or forbids uploads; a running share restarts so the change applies. */
  const changeUpload = async (on: boolean) => {
    setUpload(on);
    if (!info) return;
    try { await restart(folder); toast.success(on ? "Uploads are on. Phones must sign in again." : "Uploads are off. Phones must sign in again."); } catch (e) { toast.error(shareErrorMessage(e)); }
  };

  /** Allows or forbids renaming, moving and deleting; a running share restarts so the change applies. */
  const changeManage = async (on: boolean) => {
    setManage(on);
    if (!info) return;
    try { await restart(folder); toast.success(on ? "File management is on. Phones must sign in again." : "File management is off. Phones must sign in again."); } catch (e) { toast.error(shareErrorMessage(e)); }
  };

  /** Turns HTTPS on or off; a running share restarts so the change applies. */
  const changeHttps = async (on: boolean) => {
    setHttps(on);
    if (!info) return;
    try { await restart(folder); toast.success(on ? "HTTPS is on. Phones must sign in again." : "HTTPS is off. Phones must sign in again."); } catch (e) { toast.error(shareErrorMessage(e)); }
  };

  const shownUser = info?.username ?? (user || DEFAULT_SHARE_USER);
  const shownPass = info ? "•".repeat(Math.min(info.password.length, 12)) : pass ? "•".repeat(Math.min(pass.length, 12)) : "random";
  const mode = shareMode(info ? info.upload : upload || manage, info ? info.manage : manage);

  return (
    <div className="flex flex-col gap-5">
      <SettingsGroup title="Sharing" description="Open the files of this computer on your phone, on the same Wi-Fi, in the phone's browser or any WebDAV app.">
        <SettingRow id="share.enabled" label="Share this folder" keywords={[...KW, "server", "turn on"]}
                    description={info ? `On${info.https ? ", encrypted" : ""}. A phone can: ${mode.toLowerCase()}.` : https ? "Turns on while Notiq is open. The connection is encrypted with a certificate Notiq makes." : "Turns on while Notiq is open. The connection isn't encrypted, so use a network you trust."}>
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1.5 text-xs text-[var(--color-text-muted)]" aria-live="polite">
              <span aria-hidden className={`h-2 w-2 rounded-full ${info ? "bg-[var(--color-success)]" : "bg-[var(--color-border)]"}`} />
              {busy ? "Working…" : info ? "Sharing" : "Off"}
            </span>
            <Toggle aria-label="Share this folder to phone" value={!!info} disabled={busy || (!info && !folder)} onChange={(v) => void toggle(v)} />
          </div>
        </SettingRow>

        <SettingRow id="share.folder" label="Folder to share"
                    description={`${folder || "No folder picked yet"} — the folder of this computer a phone can open.${info ? " Stop sharing to change it." : ""}`}
                    keywords={[...KW, "folder", "directory", "choose", "path"]}
                    modified={!!folder} onReset={() => { setFolder(""); setShareFolder(""); }} disabled={!!info}>
          <Button className="settings-btn" size="sm" icon={<FolderOpen size={12} />} disabled={!!info || busy} onClick={() => void choose()}>Choose…</Button>
        </SettingRow>

        <SettingRow id="share.https" label="Use HTTPS (encrypted)" keywords={[...KW, "https", "ssl", "tls", "certificate", "encrypt", "secure", "self-signed"]}
                    description="Encrypts the connection with a self-signed certificate. Browsers warn once; some WebDAV apps refuse it. Changing this restarts sharing."
                    modified={https} onReset={() => void changeHttps(false)}>
          <Toggle aria-label="Use HTTPS" value={https} disabled={busy} onChange={(v) => void changeHttps(v)} />
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
                {info.https && info.fingerprint && <Field label="Fingerprint" value={info.fingerprint} />}
                {info.https && (
                  <p className="text-[11px] leading-relaxed text-[var(--color-text-muted)]">
                    The phone will say the certificate isn't trusted, because Notiq made it. Open its details, check that the SHA-256 fingerprint matches the one above, then continue.
                  </p>
                )}
                <p className="text-[11px] text-[var(--color-text-muted)]">Windows may ask to allow Notiq through its firewall: allow it on private networks.</p>
              </div>
            </div>
          </div>
        )}
      </SettingsGroup>

      <SettingsGroup title="Sign-in" description="What a phone must enter. Changing it while sharing restarts sharing, and phones sign in again.">
        <SettingRow id="share.login" label="User name and password" keywords={[...KW, "user name", "username", "password", "login", "custom", "change", "update"]}
                    description={`User name ${shownUser} · password ${shownPass}`}
                    modified={!!user || !!pass} onReset={() => void save("", "")}>
          <Button className="settings-btn" size="sm" disabled={busy} onClick={() => setEditing(true)}>Edit…</Button>
        </SettingRow>

        <SettingRow id="share.qr-login" label="Put the password in the QR code"
                    description="Off: after scanning, the phone asks for the sign-in. On: it signs in without asking, but anyone who can see the QR code can sign in."
                    keywords={[...KW, "password", "ask", "prompt", "scan"]} modified={qrLogin} onReset={() => { setQrLogin(false); setQrWithLogin(false); }}>
          <Toggle aria-label="Put the password in the QR code" value={qrLogin} onChange={(v) => { setQrLogin(v); setQrWithLogin(v); }} />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title="What a phone can do" description="A phone can always look at the folder and download from it.">
        <SettingRow id="share.upload" label="Allow uploads from the phone" keywords={[...KW, "upload", "send", "write", "add files", "camera", "photos"]}
                    description={manage ? "Included in renaming, moving and deleting (turn that off to change this)." : "The phone can add new files and folders. Nothing is ever replaced. Changing this restarts sharing."}
                    disabled={manage} modified={!upload && !manage} onReset={() => void changeUpload(true)}>
          <Toggle aria-label="Allow uploads from the phone" value={upload || manage} disabled={busy || manage} onChange={(v) => void changeUpload(v)} />
        </SettingRow>

        <SettingRow id="share.manage" label="Allow renaming, moving and deleting" keywords={[...KW, "manage", "rename", "move", "copy", "delete", "remove", "file manager"]}
                    description="The phone can rename, move, copy and delete files and folders of the shared folder. A delete can't be undone. Existing files are never replaced. Changing this restarts sharing."
                    modified={manage} onReset={() => void changeManage(false)}>
          <Toggle aria-label="Allow renaming, moving and deleting" value={manage} disabled={busy} onChange={(v) => void changeManage(v)} />
        </SettingRow>
      </SettingsGroup>

      {editing && <WebdavSignInDialog user={info?.username ?? user} pass={info?.password ?? pass} running={!!info} onSave={(u, p) => void save(u, p)} onClose={() => setEditing(false)} />}
    </div>
  );
}

const meta = (id: string, group: string, label: string, description: string, extra: string[] = []): SettingMeta =>
  ({ id, section: "share", group, label, description, keywords: [...KW, ...extra] });

/** The searchable settings this section renders (see lib/settingsIndex.ts). */
export const SHARE_INDEX: SettingMeta[] = [
  meta("share.enabled", "Sharing", "Share this folder", "Turns on a WebDAV server for the folder, on the local network, with a user name and password.", ["server", "turn on"]),
  meta("share.https", "Sharing", "Use HTTPS (encrypted)", "Encrypts the connection with a self-signed certificate that Notiq makes for this computer.", ["https", "ssl", "tls", "certificate", "encrypt", "secure", "self-signed"]),
  meta("share.folder", "Sharing", "Folder to share", "The folder of this computer a phone on the same Wi-Fi can open.", ["folder", "directory", "choose"]),
  meta("share.login", "Sign-in", "User name and password", "The user name and password a phone must enter. Change them while sharing, or reset to notiq and a random password.", ["user name", "username", "password", "login", "custom"]),
  meta("share.qr-login", "Sign-in", "Put the password in the QR code", "Off: after scanning, the phone asks for the user name and password. On: it signs in without asking.", ["password", "ask", "prompt", "scan"]),
  meta("share.upload", "What a phone can do", "Allow uploads from the phone", "The phone can add new files and folders. Nothing is overwritten, deleted or moved.", ["upload", "send", "write", "add files", "camera", "photos"]),
  meta("share.manage", "What a phone can do", "Allow renaming, moving and deleting", "The phone can rename, move, copy and delete files and folders of the shared folder. A delete can't be undone.", ["manage", "rename", "move", "copy", "delete", "remove", "file manager"]),
];

export const SETTINGS_INDEX: SettingMeta[] = SHARE_INDEX;
