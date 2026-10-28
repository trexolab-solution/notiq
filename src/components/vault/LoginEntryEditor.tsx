import { useEffect, useMemo, useState } from "react";
import { Dices, ExternalLink, Eye, EyeOff, KeyRound } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { useAppStore } from "../../store";
import { CopyIconButton } from "./CopyIconButton";
import {
  generatePassword, hostOf, parseLogin, serializeLogin, totpCode, totpRemaining, type LoginEntry,
} from "../../lib/loginEntry";
import type { Tab } from "../../types";

/** Structured editor for a `login` vault entry (replaces the text editor). */
export function LoginEntryEditor({ tab }: { tab: Tab }) {
  const entry = useMemo(() => parseLogin(tab.content), [tab.content]);
  const [show, setShow] = useState(false);
  const [code, setCode] = useState<string | null>(null);
  const [left, setLeft] = useState(totpRemaining());

  const set = (patch: Partial<LoginEntry>) =>
    useAppStore.getState().updateTabContent(tab.id, serializeLogin({ ...entry, ...patch }));

  // Live 2-step code.
  useEffect(() => {
    if (!entry.totp.trim()) { setCode(null); return; }
    let alive = true;
    const tick = async () => {
      setLeft(totpRemaining());
      const c = await totpCode(entry.totp);
      if (alive) setCode(c ? `${c.slice(0, 3)} ${c.slice(3)}` : null);
    };
    void tick();
    const id = setInterval(() => { void tick(); }, 1000);
    return () => { alive = false; clearInterval(id); };
  }, [entry.totp]);

  const host = hostOf(entry.url);
  const label = "block text-xs mb-1 text-[var(--color-text-muted)]";
  const row = "flex items-center gap-2";

  return (
    <div data-tour="editor" className="flex-1 min-h-0 overflow-y-auto bg-[var(--color-editor-bg)]">
      <div className="max-w-xl mx-auto px-6 py-8 flex flex-col gap-4 text-[var(--color-text)]">
        <div className="flex items-center gap-2">
          <KeyRound size={18} style={{ color: "var(--color-primary)" }} />
          <h1 className="text-base font-semibold">Login</h1>
        </div>

        <div>
          <label className={label} htmlFor="le-title">Name</label>
          <Input id="le-title" value={entry.title} onChange={(e) => set({ title: e.target.value })} placeholder="e.g. Google" />
        </div>

        <div>
          <label className={label} htmlFor="le-url">Website</label>
          <div className={row}>
            <Input id="le-url" value={entry.url} onChange={(e) => set({ url: e.target.value })}
                   placeholder="https://accounts.google.com" spellCheck={false} />
            {host && (
              <Button size="sm" icon={<ExternalLink size={12} />}
                      onClick={() => { void openUrl(`https://${host}`); }}>Open</Button>
            )}
          </div>
        </div>

        <div>
          <label className={label} htmlFor="le-user">Username or email</label>
          <div className={row}>
            <Input id="le-user" value={entry.username} onChange={(e) => set({ username: e.target.value })}
                   autoComplete="off" spellCheck={false} />
            <CopyIconButton value={entry.username} label="username" />
          </div>
        </div>

        <div>
          <label className={label} htmlFor="le-pass">Password</label>
          <div className={row}>
            <Input id="le-pass" type={show ? "text" : "password"} value={entry.password}
                   onChange={(e) => set({ password: e.target.value })}
                   autoComplete="off" spellCheck={false} className="font-mono" />
            <Button size="sm" aria-label={show ? "Hide password" : "Show password"}
                    icon={show ? <EyeOff size={12} /> : <Eye size={12} />} onClick={() => setShow((v) => !v)} />
            <Button size="sm" icon={<Dices size={12} />} title="Generate a strong password"
                    onClick={() => { set({ password: generatePassword(20) }); setShow(true); }}>Generate</Button>
            <CopyIconButton value={entry.password} label="password" />
          </div>
        </div>

        <div>
          <label className={label} htmlFor="le-totp">2-step secret (optional)</label>
          <Input id="le-totp" value={entry.totp} onChange={(e) => set({ totp: e.target.value })}
                 placeholder="Base32 key from the site's QR setup" autoComplete="off" spellCheck={false} className="font-mono" />
          {code && (
            <div className={`${row} mt-2`}>
              <span className="font-mono text-lg tracking-wider">{code}</span>
              <span className="text-xs text-[var(--color-text-muted)]">{left}s</span>
              <CopyIconButton value={code.replace(" ", "")} label="2-step code" />
            </div>
          )}
          {entry.totp.trim() && !code && <p className="text-xs mt-1 text-[var(--color-danger)]">That doesn't look like a valid secret.</p>}
        </div>

        <div>
          <label className={label} htmlFor="le-notes">Notes</label>
          <textarea id="le-notes" rows={4} value={entry.notes} onChange={(e) => set({ notes: e.target.value })}
                    className="w-full rounded-md px-2.5 py-2 text-sm bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] outline-none focus:border-[var(--color-primary)]" />
        </div>

        <p className="text-xs text-[var(--color-text-muted)]">
          Saved with the vault when you save this tab (Ctrl+S). Copied values are cleared from the clipboard after 20 seconds.
        </p>
      </div>
    </div>
  );
}
