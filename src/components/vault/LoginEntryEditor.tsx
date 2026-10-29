import { useEffect, useMemo, useState } from "react";
import { ExternalLink, Eye, EyeOff, KeyRound, Plus, X } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { useAppStore } from "../../store";
import { CopyIconButton } from "./CopyIconButton";
import { useAutoHide } from "../../hooks/useAutoHide";
import { GeneratePasswordButton } from "./GeneratePasswordButton";
import { Tooltip } from "../ui/Tooltip";
import { CustomFieldsEditor } from "./CustomFieldsEditor";
import { AttachmentsPanel } from "./AttachmentsPanel";
import { EntryHeader, SaveHint } from "./EntryParts";
import {
  extraUrlError, hostOf, MAX_LOGIN_URLS, parseLogin, serializeLogin, totpCode, totpRemaining, type LoginEntry,
} from "../../lib/loginEntry";
import type { Tab } from "../../types";

/** Structured editor for a `login` vault entry (replaces the text editor). */
export function LoginEntryEditor({ tab }: { tab: Tab }) {
  const entry = useMemo(() => parseLogin(tab.content), [tab.content]);
  const [show, setShow] = useState(false);
  useAutoHide(show, setShow);
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
        <EntryHeader icon={KeyRound} title="Login" tab={tab} />

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
          <OtherSites entry={entry} onChange={(urls) => set({ urls })} />
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
            <GeneratePasswordButton onGenerate={(password) => { set({ password }); setShow(true); }} />
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

        <CustomFieldsEditor value={entry.custom ?? []} onChange={(custom) => set({ custom })} />
        <AttachmentsPanel tab={tab} />
        <SaveHint />
      </div>
    </div>
  );
}

/** Compact list of extra sites the same login works on (`entry.urls`), with an add box. */
function OtherSites({ entry, onChange }: { entry: LoginEntry; onChange: (urls: string[]) => void }) {
  const [draft, setDraft] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const urls = entry.urls ?? [];
  const full = urls.length >= MAX_LOGIN_URLS;

  const add = () => {
    const why = extraUrlError(draft, entry);
    if (why) { setErr(why); return; }
    onChange([...urls, draft.trim()]);
    setDraft(""); setErr(null);
  };

  return (
    <div className="mt-2 flex flex-col gap-1">
      {urls.map((u, i) => (
        <div key={`${u}-${i}`} className="flex items-center gap-2 pl-2 text-xs">
          <span className="text-[var(--color-text-muted)]" aria-hidden>+</span>
          <span className="flex-1 min-w-0 truncate" title={u}>{u}</span>
          <Tooltip content="Remove this site">
            <Button size="sm" variant="danger" aria-label={`Remove ${u}`} icon={<X size={12} />}
                    onClick={() => onChange(urls.filter((_, j) => j !== i))} />
          </Tooltip>
        </div>
      ))}
      {adding ? (
        <div>
          <div className="flex items-center gap-2">
            <Input aria-label="Another site for this login" value={draft} autoFocus spellCheck={false} placeholder="e.g. https://login.example.co.uk"
                   aria-invalid={!!err} className={err ? "!border-[var(--color-danger)]" : ""}
                   onChange={(e) => { setDraft(e.target.value); setErr(null); }}
                   onKeyDown={(e) => {
                     if (e.key === "Enter") { e.preventDefault(); add(); }
                     else if (e.key === "Escape") { e.preventDefault(); setAdding(false); setDraft(""); setErr(null); }
                   }} />
            <Button size="sm" onClick={add}>Add</Button>
            <Button size="sm" onClick={() => { setAdding(false); setDraft(""); setErr(null); }}>Cancel</Button>
          </div>
          {err && <p className="text-xs mt-1 text-[var(--color-danger)]">{err}</p>}
        </div>
      ) : (
        <div>
          <Button size="sm" icon={<Plus size={12} />} disabled={full}
                  title={full ? `At most ${MAX_LOGIN_URLS} other sites` : "Use this login on another website too"}
                  onClick={() => setAdding(true)}>
            {urls.length ? "Add another site" : "Other sites"}
          </Button>
        </div>
      )}
    </div>
  );
}
