import { useCallback, useEffect, useState } from "react";
import { Cloud } from "lucide-react";
import { SettingRow } from "../SettingRow";
import { Button } from "../Button";
import { Toggle } from "../Toggle";
import { Input } from "../Input";
import { PasswordInput } from "../PasswordInput";
import { toast } from "../../../lib/toast";
import {
  TG_EVENT, errText, getTgAutoSync, setTgAutoSync, runSync,
  gdriveConnect, tgClear, tgDetectChat, tgSaveConfig, tgStatus, type TgStatus,
} from "../../../lib/telegram";

/** Settings → Vault: back up encrypted notes to the user's own Telegram bot. */
export function TelegramSection() {
  const [st, setSt]         = useState<TgStatus | null>(null);
  const [token, setToken]   = useState("");
  const [chatId, setChatId] = useState("");
  const [busy, setBusy]     = useState<string | null>(null);
  const [auto, setAuto]     = useState(getTgAutoSync);
  const [confirmOff, setConfirmOff] = useState(false);
  const [prov, setProv]     = useState<"telegram" | "gdrive">("gdrive");

  const refresh = useCallback(() => { tgStatus().then(setSt).catch(() => setSt(null)); }, []);
  useEffect(() => {
    refresh();
    window.addEventListener(TG_EVENT, refresh);
    return () => window.removeEventListener(TG_EVENT, refresh);
  }, [refresh]);

  const run = async (label: string, fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(label);
    try { await fn(); } catch (e) { toast.error(errText(e)); } finally { setBusy(null); }
  };

  const detect = () => run("detect", async () => {
    const id = await tgDetectChat(token.trim());
    setChatId(String(id));
    toast.info("Chat found");
  });

  const connect = () => run("connect", async () => {
    const id = Number(chatId.trim());
    if (!token.trim() || !Number.isSafeInteger(id)) throw new Error("Enter the bot token and chat ID");
    const bot = await tgSaveConfig(token.trim(), id);
    setToken(""); setChatId("");
    toast.info(`Connected to @${bot}. The token is stored in your system keychain.`);
    refresh();
  });

  const connectDrive = () => run("gdrive", async () => {
    toast.info("Finish signing in in your browser…");
    const email = await gdriveConnect();
    toast.info(`Connected to Google Drive (${email}). Notiq can only see its own hidden app folder.`);
    refresh();
  });

  const sync = () => run("sync", async () => {
    const r = await runSync();
    if (!r) return;
    toast.info(`Telegram: ${r.uploaded} uploaded, ${r.downloaded.length} downloaded, ${r.skipped} unchanged${r.conflicts ? `, ${r.conflicts} conflict copies` : ""}${r.failed.length ? `, ${r.failed.length} failed` : ""}`);
    if (r.failed.length) toast.error(r.failed[0]);
  });

  const disconnect = () => run("off", async () => {
    await tgClear(); setConfirmOff(false); refresh();
  });

  return (
    <div className="flex flex-col gap-4">
      <h3 className="text-sm font-semibold text-[var(--color-text)] flex items-center gap-2">
        <Cloud size={14} /> Cloud sync
      </h3>

      {!st?.configured ? (
        <div className="flex flex-col gap-3">
          <div className="flex gap-2" role="tablist" aria-label="Storage provider">
            <Button size="sm" variant={prov === "gdrive" ? "primary" : "ghost"} onClick={() => setProv("gdrive")}>Google Drive</Button>
            <Button size="sm" variant={prov === "telegram" ? "primary" : "ghost"} onClick={() => setProv("telegram")}>Telegram</Button>
          </div>
          {prov === "gdrive" ? (
            <>
              <p className="text-xs text-[var(--color-text-muted)]">
                Sign in with Google in your browser. Notiq asks only for access to its own hidden app folder in your Drive,
                never your other files. No bot or token needed.
              </p>
              <div>
                <Button variant="primary" size="sm" disabled={!!busy} onClick={() => void connectDrive()}>
                  {busy === "gdrive" ? "Waiting for sign-in…" : "Connect Google Drive"}
                </Button>
              </div>
            </>
          ) : (<>
          <ol className="text-xs list-decimal pl-4 flex flex-col gap-1 text-[var(--color-text-muted)]">
            <li>In Telegram, open <b>@BotFather</b> → <code>/newbot</code> and copy the bot token.</li>
            <li>Open your new bot and press <b>Start</b>.</li>
            <li>Paste the token below, press <b>Detect chat</b>, then <b>Connect</b>.</li>
          </ol>
          <PasswordInput placeholder="Bot token" autoComplete="off" spellCheck={false}
                         value={token} onChange={(e) => setToken(e.target.value)} />
          <div className="flex gap-2">
            <Input placeholder="Chat ID" inputMode="numeric" value={chatId} onChange={(e) => setChatId(e.target.value)} />
            <Button size="sm" disabled={!token.trim() || !!busy} onClick={() => void detect()}>
              {busy === "detect" ? "…" : "Detect chat"}
            </Button>
          </div>
          <div>
            <Button variant="primary" size="sm" disabled={!token.trim() || !chatId.trim() || !!busy} onClick={() => void connect()}>
              {busy === "connect" ? "Connecting…" : "Connect"}
            </Button>
          </div>
          </>)}
        </div>
      ) : (
        <>
          <p className="text-xs text-[var(--color-text-muted)]">
            Connected · {st.detail} ·{" "}
            {st.last_sync ? `last sync ${new Date(st.last_sync * 1000).toLocaleString()}` : "not synced yet"}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" size="sm" disabled={!!busy} onClick={() => void sync()}>
              {busy === "sync" ? "Syncing…" : "Sync now"}
            </Button>
            {confirmOff ? (
              <>
                <Button size="sm" variant="ghost" onClick={() => void disconnect()}>Yes, disconnect</Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmOff(false)}>Keep</Button>
              </>
            ) : (
              <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => setConfirmOff(true)}>Disconnect</Button>
            )}
          </div>
          <SettingRow label="Auto-sync" description="Two-way sync with your other devices: on unlock, a few seconds after you save, every few minutes, and just before the vault locks (not for the panic shortcut).">
            <Toggle aria-label="Auto-sync after saving" value={auto} onChange={(v) => { setAuto(v); setTgAutoSync(v); }} />
          </SettingRow>
        </>
      )}

      <p className="text-xs text-[var(--color-text-muted)]">
        Only encrypted <code>.nqv</code> files are uploaded, under random names. Your storage provider never sees titles, folders or
        content. To use the same vault on another device, install Notiq there and choose "Restore" on the vault setup screen —
        you'll need your Google sign-in (or the Telegram bot token) and your master password. Anyone who can read the backup could
        try to guess your master password offline, so make it long and unique.
      </p>
    </div>
  );
}
