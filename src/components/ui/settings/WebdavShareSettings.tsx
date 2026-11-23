import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Check, Copy, Dices } from "lucide-react";
import { SettingRow } from "../SettingRow";
import { SettingsGroup } from "../SettingsGroup";
import { Toggle } from "../Toggle";
import { Button } from "../Button";
import { QrCode } from "../QrCode";
import { Input } from "../Input";
import { PasswordInput } from "../PasswordInput";
import { toast } from "../../../lib/toast";
import { useCopyToClipboard } from "../../../hooks/useCopyToClipboard";
import {
  DEFAULT_SHARE_USER, generateSharePassword, getQrWithLogin, getShareFolder, getShareUser, loginProblem, setQrWithLogin,
  setShareFolder, setShareUser, shareErrorMessage, shareLink, useShareStore,
} from "../../../lib/webdavShare";

const KW = ["webdav", "phone", "mobile", "share", "local network", "wifi", "lan", "files", "qr"];

/** One value the phone needs, with a Copy button. */
function Field({ label, value }: { label: string; value: string }) {
  const { copied, copy } = useCopyToClipboard();
  return (
    <div className="flex items-center gap-2 text-[13px]">
      <span className="w-20 shrink-0 text-[var(--color-text-muted)]">{label}</span>
      <code className="flex-1 min-w-0 truncate select-all rounded bg-[var(--color-bg-tertiary)] px-2 py-1">{value}</code>
      <Button size="sm" variant="ghost" aria-label={`Copy ${label.toLowerCase()}`} icon={copied ? <Check size={13} /> : <Copy size={13} />}
              onClick={() => void copy(value)}>{copied ? "Copied" : "Copy"}</Button>
    </div>
  );
}

/** Share one folder of this computer, read-only, with a phone on the same Wi-Fi (Settings → Vault). */
export function WebdavShareSettings() {
  const [folder, setFolder] = useState(getShareFolder);
  const [user, setUser] = useState(getShareUser);
  const [pass, setPass] = useState("");
  const [qrLogin, setQrLogin] = useState(getQrWithLogin);
  const { info, busy, refresh, start, stop, updateLogin } = useShareStore();

  useEffect(() => { void refresh(); }, [refresh]);
  // While sharing, the fields show what is in force now (also after the tray or palette started it).
  useEffect(() => { if (info) { setUser(info.username); setPass(info.password); } }, [info]);

  const problem = loginProblem(user, pass, !!info);
  const dirty = !!info && ((user.trim() || DEFAULT_SHARE_USER) !== info.username || pass !== info.password);

  const choose = async () => {
    const picked = await open({ directory: true, multiple: false, defaultPath: folder || undefined });
    if (typeof picked === "string") { setFolder(picked); setShareFolder(picked); }
  };

  const toggle = async (on: boolean) => {
    if (on && problem) { toast.error(problem); return; }
    try { if (on) { setShareUser(user.trim()); await start(folder, user, pass); } else await stop(); } catch (e) { toast.error(shareErrorMessage(e)); }
  };

  /** Applies the typed sign-in to the running share (`reset`: back to notiq + a new random password). */
  const apply = async (reset = false) => {
    try {
      await updateLogin(reset ? "" : user, reset ? "" : pass);
      if (!reset) setShareUser(user.trim()); else setShareUser("");
      toast.success(reset ? "Sign-in reset. Phones must sign in again." : "Sign-in updated. Phones must sign in again.");
    } catch (e) { toast.error(shareErrorMessage(e)); }
  };

  return (
    <SettingsGroup title="Share files to phone"
                   description="Lets a phone on the same Wi-Fi browse and download one folder of this computer, using any WebDAV app. Read-only: nothing can be changed from the phone.">
      <SettingRow id="vault.share.folder" label="Folder to share" description={folder || "No folder picked yet."} keywords={[...KW, "folder", "directory", "choose"]}>
        <Button size="sm" variant="ghost" disabled={!!info || busy} onClick={() => void choose()}>{folder ? "Change…" : "Choose…"}</Button>
      </SettingRow>

      <SettingRow id="vault.share.login" label="Sign-in" keywords={[...KW, "user name", "username", "password", "login", "custom", "change", "update"]}
                  description={info
                    ? "What a phone must enter. Changing it takes effect at once, and phones signed in with the old one must sign in again."
                    : "Leave the password empty for a random one. The user name is “notiq” unless you type another. The password isn't saved."}
                  layout="stacked">
        <div className="flex flex-col gap-2 max-w-[460px]">
          <label className="flex items-center gap-2 text-[13px]">
            <span className="w-20 shrink-0 text-[var(--color-text-muted)]">User name</span>
            <Input aria-label="Share user name" placeholder={DEFAULT_SHARE_USER} value={user} disabled={busy} maxLength={32} autoComplete="off"
                   aria-invalid={!!problem} onChange={(e) => setUser(e.target.value)} />
          </label>
          <div className="flex items-center gap-2 text-[13px]">
            <span className="w-20 shrink-0 text-[var(--color-text-muted)]">Password</span>
            <PasswordInput aria-label="Share password" placeholder="Random" value={pass} disabled={busy} maxLength={64} autoComplete="new-password"
                           aria-invalid={!!problem} onChange={(e) => setPass(e.target.value)} />
            <Button size="sm" variant="ghost" icon={<Dices size={13} />} disabled={busy} onClick={() => setPass(generateSharePassword())}>Generate</Button>
          </div>
          {problem && <p role="alert" className="pl-[88px] text-[12px] text-[var(--color-danger)]">{problem}</p>}
          {info && (
            <div className="flex items-center gap-2 pl-[88px]">
              <Button size="sm" variant="primary" disabled={!dirty || !!problem || busy} onClick={() => void apply()}>Update sign-in</Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void apply(true)}>Reset to default</Button>
            </div>
          )}
        </div>
      </SettingRow>

      <SettingRow id="vault.share.enabled" label="Share this folder"
                  description="Turns on while Notiq is open. The connection isn't encrypted, so use a network you trust."
                  keywords={[...KW, "server", "turn on"]}>
        <Toggle aria-label="Share this folder to phone" value={!!info} disabled={busy || (!info && !folder)} onChange={(v) => void toggle(v)} />
      </SettingRow>

      <SettingRow id="vault.share.qr-login" label="Put the password in the QR code"
                  description="Off: after scanning, the phone asks for the user name and password. On: it signs in without asking, but anyone who can see the QR code can sign in."
                  keywords={[...KW, "password", "ask", "prompt", "scan"]}>
        <Toggle aria-label="Put the password in the QR code" value={qrLogin} onChange={(v) => { setQrLogin(v); setQrWithLogin(v); }} />
      </SettingRow>

      {info && (
        <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row" data-testid="webdav-share-info">
          <div className="flex flex-col items-center gap-1 shrink-0">
            <QrCode value={qrLogin ? shareLink(info) : info.url} label={qrLogin ? "QR code with the address and password" : "QR code with the address"} />
            <span className="text-[11px] text-[var(--color-text-muted)]">Scan with the phone's camera</span>
          </div>
          <div className="flex flex-1 min-w-0 flex-col gap-2">
            <p className="text-[12px] text-[var(--color-text-muted)]">
              {qrLogin ? "The QR code opens the folder in the phone's browser, already signed in." : "The QR code opens the folder in the phone's browser, which asks for the user name and password."}
              {" "}For a WebDAV app (Solid Explorer, Documents, Files, FolderSync…), add a server with these details. Windows may ask to allow Notiq through its firewall: allow it on private networks.
            </p>
            <Field label="Address" value={info.url} />
            <Field label="User name" value={info.username} />
            <Field label="Password" value={info.password} />
          </div>
        </div>
      )}
    </SettingsGroup>
  );
}
