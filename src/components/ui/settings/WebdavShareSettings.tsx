import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Check, Copy } from "lucide-react";
import { SettingRow } from "../SettingRow";
import { SettingsGroup } from "../SettingsGroup";
import { Toggle } from "../Toggle";
import { Button } from "../Button";
import { QrCode } from "../QrCode";
import { toast } from "../../../lib/toast";
import { useCopyToClipboard } from "../../../hooks/useCopyToClipboard";
import { PasswordInput } from "../PasswordInput";
import { Input } from "../Input";
import {
  getShareFolder, getShareUser, setShareFolder, setShareUser, shareErrorMessage, shareLink, useShareStore,
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
  const { info, busy, refresh, start, stop } = useShareStore();

  useEffect(() => { void refresh(); }, [refresh]);

  const choose = async () => {
    const picked = await open({ directory: true, multiple: false, defaultPath: folder || undefined });
    if (typeof picked === "string") { setFolder(picked); setShareFolder(picked); }
  };

  const toggle = async (on: boolean) => {
    try { if (on) { setShareUser(user.trim()); await start(folder, user, pass); } else await stop(); } catch (e) { toast.error(shareErrorMessage(e)); }
  };

  return (
    <SettingsGroup title="Share files to phone"
                   description="Lets a phone on the same Wi-Fi browse and download one folder of this computer, using any WebDAV app. Read-only: nothing can be changed from the phone.">
      <SettingRow id="vault.share.folder" label="Folder to share" description={folder || "No folder picked yet."} keywords={[...KW, "folder", "directory", "choose"]}>
        <Button size="sm" variant="ghost" disabled={!!info || busy} onClick={() => void choose()}>{folder ? "Change…" : "Choose…"}</Button>
      </SettingRow>

      <SettingRow id="vault.share.login" label="User name and password" keywords={[...KW, "user name", "username", "password", "login", "custom"]}
                  description="Leave them empty to use the user name “notiq” and a new random password each time. A password needs at least 8 characters. The password isn't saved: type it again next time."
                  layout="stacked">
        <div className="flex gap-2 max-w-[460px]">
          <Input aria-label="Share user name" placeholder="User name (notiq)" value={user} disabled={!!info || busy} maxLength={32} autoComplete="off"
                 onChange={(e) => setUser(e.target.value)} />
          <PasswordInput aria-label="Share password" placeholder="Password (random)" value={pass} disabled={!!info || busy} maxLength={64} autoComplete="new-password"
                         onChange={(e) => setPass(e.target.value)} />
        </div>
      </SettingRow>

      <SettingRow id="vault.share.enabled" label="Share this folder"
                  description="Turns on while Notiq is open. A new password is made each time. The connection isn't encrypted, so use a network you trust."
                  keywords={[...KW, "server", "turn on"]}>
        <Toggle aria-label="Share this folder to phone" value={!!info} disabled={busy || (!info && !folder)} onChange={(v) => void toggle(v)} />
      </SettingRow>

      {info && (
        <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row" data-testid="webdav-share-info">
          <div className="flex flex-col items-center gap-1 shrink-0">
            <QrCode value={shareLink(info)} label="QR code with the address and password" />
            <span className="text-[11px] text-[var(--color-text-muted)]">Scan with the phone's camera</span>
          </div>
          <div className="flex flex-1 min-w-0 flex-col gap-2">
            <p className="text-[12px] text-[var(--color-text-muted)]">
              The QR code opens the folder in the phone's browser. For a WebDAV app (Solid Explorer, Documents, Files, FolderSync…), add a server with these details. Windows may ask to allow Notiq through its firewall: allow it on private networks.
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
