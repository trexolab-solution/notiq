import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Check, Copy } from "lucide-react";
import { SettingRow } from "../SettingRow";
import { SettingsGroup } from "../SettingsGroup";
import { Toggle } from "../Toggle";
import { Button } from "../Button";
import { toast } from "../../../lib/toast";
import { useCopyToClipboard } from "../../../hooks/useCopyToClipboard";
import {
  getShareFolder, setShareFolder, webdavStart, webdavStatus, webdavStop, type ShareInfo,
} from "../../../lib/webdavShare";

const KW = ["webdav", "phone", "mobile", "share", "local network", "wifi", "lan", "files"];

const message = (e: unknown) => (typeof e === "string" ? e : e instanceof Error ? e.message : "Couldn't change sharing.");

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
  const [info, setInfo] = useState<ShareInfo | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { void webdavStatus().then(setInfo).catch(() => {}); }, []);

  const choose = async () => {
    const picked = await open({ directory: true, multiple: false, defaultPath: folder || undefined });
    if (typeof picked === "string") { setFolder(picked); setShareFolder(picked); }
  };

  const toggle = async (on: boolean) => {
    setBusy(true);
    try {
      if (on) setInfo(await webdavStart(folder)); else { await webdavStop(); setInfo(null); }
    } catch (e) { toast.error(message(e)); } finally { setBusy(false); }
  };

  return (
    <SettingsGroup title="Share files to phone"
                   description="Lets a phone on the same Wi-Fi browse and download one folder of this computer, using any WebDAV app. Read-only: nothing can be changed from the phone.">
      <SettingRow id="vault.share.folder" label="Folder to share" description={folder || "No folder picked yet."} keywords={[...KW, "folder", "directory", "choose"]}>
        <Button size="sm" variant="ghost" disabled={!!info || busy} onClick={() => void choose()}>{folder ? "Change…" : "Choose…"}</Button>
      </SettingRow>

      <SettingRow id="vault.share.enabled" label="Share this folder"
                  description="Turns on while Notiq is open. A new password is made each time. The connection isn't encrypted, so use a network you trust."
                  keywords={[...KW, "server", "webdav", "turn on"]}>
        <Toggle aria-label="Share this folder to phone" value={!!info} disabled={busy || (!info && !folder)} onChange={(v) => void toggle(v)} />
      </SettingRow>

      {info && (
        <div className="flex flex-col gap-2 px-4 py-3" data-testid="webdav-share-info">
          <p className="text-[12px] text-[var(--color-text-muted)]">
            In a WebDAV app on your phone (Solid Explorer, Documents, Files, FolderSync…), add a server with these details. Windows may ask to allow Notiq through its firewall: allow it on private networks.
          </p>
          <Field label="Address" value={info.url} />
          <Field label="User name" value={info.username} />
          <Field label="Password" value={info.password} />
        </div>
      )}
    </SettingsGroup>
  );
}
