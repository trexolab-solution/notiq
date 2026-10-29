import { useMemo, useState } from "react";
import { ChevronRight, Eye, EyeOff, FileUp, KeyRound, ShieldCheck, Terminal, TriangleAlert } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { SegmentedControl } from "../ui/SegmentedControl";
import { Tooltip } from "../ui/Tooltip";
import { useAppStore } from "../../store";
import { useAutoHide } from "../../hooks/useAutoHide";
import { CopyIconButton } from "./CopyIconButton";
import { toast } from "../../lib/toast";
import { parseSecret, serializeSecret } from "../../lib/secretEntry";
import { analyzeKey, inferAuth, normalizeKey, portError, sshCommand, type SshAuth } from "../../lib/sshEntry";
import type { Tab } from "../../types";

const MAX_KEY_BYTES = 64 * 1024;
const label = "block text-xs mb-1 text-[var(--color-text-muted)]";
const area = "w-full rounded-md px-2.5 py-2 text-sm bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] outline-none focus:border-[var(--color-primary)]";

/** Every field row has the same fixed-width action slot, so all inputs line up. */
function Row({ htmlFor, text, hint, children, actions }: {
  htmlFor: string; text: string; hint?: string; children: React.ReactNode; actions?: React.ReactNode;
}) {
  return (
    <div>
      <label className={label} htmlFor={htmlFor}>
        {text}{hint && <span className="ml-1.5 opacity-70">{hint}</span>}
      </label>
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">{children}</div>
        <div className="w-[68px] shrink-0 flex items-center justify-end gap-1 pt-px">{actions}</div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)] border-b border-[var(--color-border)] pb-1">{title}</h2>
      {children}
    </section>
  );
}

/** Section whose body can be folded away; the header shows what's inside while it's closed. */
function CollapsibleSection({ title, summary, open, onToggle, children }: {
  title: string; summary: string; open: boolean; onToggle: () => void; children: React.ReactNode;
}) {
  const id = "ssh-advanced";
  return (
    <section className="flex flex-col gap-3">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={onToggle}
        className="flex items-center gap-1.5 w-full text-left pb-1 border-b border-[var(--color-border)] cursor-pointer text-[var(--color-text-muted)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/50 rounded-sm"
      >
        <ChevronRight size={13} aria-hidden className="shrink-0 transition-transform motion-reduce:transition-none" style={{ transform: open ? "rotate(90deg)" : "none" }} />
        <span className="text-[11px] font-semibold uppercase tracking-wider">{title}</span>
        {!open && <span className="ml-1 text-[11px] normal-case tracking-normal truncate opacity-70">{summary}</span>}
      </button>
      {open && <div id={id} className="flex flex-col gap-3">{children}</div>}
    </section>
  );
}

function RevealButton({ shown, onToggle, name }: { shown: boolean; onToggle: () => void; name: string }) {
  return (
    <Tooltip content={shown ? `Hide ${name}` : `Show ${name}`}>
      <Button size="sm" aria-label={shown ? `Hide ${name}` : `Show ${name}`} aria-pressed={shown}
              icon={shown ? <EyeOff size={13} /> : <Eye size={13} />} onClick={onToggle} />
    </Tooltip>
  );
}

/** SSH / server entry: pick how you sign in and only the relevant fields show; keys are checked as you paste. */
export function SshEntryEditor({ tab }: { tab: Tab }) {
  const entry = useMemo(() => parseSecret("ssh", tab.content), [tab.content]);
  const f = entry.fields;
  const auth = inferAuth(f);
  const [showPass, setShowPass] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [showPhrase, setShowPhrase] = useState(false);
  useAutoHide(showPass, setShowPass);
  useAutoHide(showKey, setShowKey);
  useAutoHide(showPhrase, setShowPhrase);
  // Advanced starts folded, but opens by itself when it already holds something.
  const [advOpen, setAdvOpen] = useState(() => !!(f.jump || f.fingerprint || f.notes));

  const save = (next: typeof entry) => useAppStore.getState().updateTabContent(tab.id, serializeSecret(next));
  const setField = (key: string, value: string) => save({ ...entry, fields: { ...f, [key]: value } });

  const key = analyzeKey(f.privateKey ?? "");
  const command = sshCommand(f);
  const portErr = portError(f.port ?? "");
  const needsPassphrase = key.state === "encrypted" || key.state === "empty" || key.state === "invalid" || key.state === "incomplete" || !!f.passphrase;

  const importKey = async () => {
    try {
      const path = await open({ multiple: false, directory: false, title: "Choose a private key file" });
      if (typeof path !== "string") return;
      const text = await readTextFile(path);
      if (text.length > MAX_KEY_BYTES) { toast.error("That file is too large to be a private key"); return; }
      const info = analyzeKey(text);
      if (info.state === "public") { toast.warning("That's a public key (.pub). Choose the private key file."); return; }
      setField("privateKey", normalizeKey(text));
      setField("auth", "key");
      toast.info(info.state === "invalid" ? "Imported, but it doesn't look like a private key" : "Key imported");
    } catch (e) {
      toast.error(`Couldn't read that file: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const keyTone = key.state === "ok" ? "var(--color-success)" : key.state === "encrypted" ? "var(--color-primary)" : "var(--color-danger)";
  const KeyIcon = key.state === "ok" ? ShieldCheck : key.state === "encrypted" ? KeyRound : TriangleAlert;

  return (
    <div data-tour="editor" className="flex-1 min-h-0 overflow-y-auto bg-[var(--color-editor-bg)]">
      <div className="max-w-xl mx-auto px-6 py-8 flex flex-col gap-6 text-[var(--color-text)]">
        <div className="flex items-center gap-2">
          <Terminal size={18} style={{ color: "var(--color-primary)" }} />
          <h1 className="text-base font-semibold">SSH / server</h1>
        </div>

        <div>
          <label className={label} htmlFor="ssh-title">Name</label>
          <Input id="ssh-title" value={entry.title} placeholder="e.g. Production VPS"
                 onChange={(e) => save({ ...entry, title: e.target.value })} />
        </div>

        <Section title="Connection">
          <div className="flex gap-3">
            <div className="flex-1 min-w-0">
              <Row htmlFor="ssh-host" text="Host or IP" actions={<CopyIconButton value={f.host ?? ""} label="host" />}>
                <Input id="ssh-host" value={f.host ?? ""} placeholder="server.example.com" spellCheck={false} autoComplete="off"
                       onChange={(e) => setField("host", e.target.value.trim())} />
              </Row>
            </div>
            <div className="w-[148px] shrink-0">
              <Row htmlFor="ssh-port" text="Port" actions={<CopyIconButton value={f.port ?? ""} label="port" />}>
                <Input id="ssh-port" value={f.port ?? ""} placeholder="22" inputMode="numeric" spellCheck={false}
                       aria-invalid={!!portErr} className={portErr ? "!border-[var(--color-danger)]" : ""}
                       onChange={(e) => setField("port", e.target.value.replace(/\D/g, "").slice(0, 5))} />
              </Row>
            </div>
          </div>
          {portErr && <p className="text-xs -mt-2 text-[var(--color-danger)]">{portErr}</p>}

          <Row htmlFor="ssh-user" text="Username" actions={<CopyIconButton value={f.username ?? ""} label="username" />}>
            <Input id="ssh-user" value={f.username ?? ""} placeholder="root" spellCheck={false} autoComplete="off"
                   onChange={(e) => setField("username", e.target.value.trim())} />
          </Row>

          {command && (
            <div className="flex items-center gap-2 rounded-md px-2.5 py-1.5 bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
              <code className="flex-1 min-w-0 truncate text-xs font-mono" title={command}>{command}</code>
              <CopyIconButton value={command} label="ssh command" />
            </div>
          )}
        </Section>

        <Section title="Sign in">
          <SegmentedControl<SshAuth>
            className="self-start" // hug the options instead of stretching across the form
            aria-label="Sign-in method"
            value={auth}
            onChange={(v) => setField("auth", v)}
            options={[{ value: "key", label: "Private key" }, { value: "password", label: "Password" }]}
          />

          {auth === "password" ? (
            <Row htmlFor="ssh-pass" text="Password"
                 actions={<>
                   <RevealButton shown={showPass} onToggle={() => setShowPass((v) => !v)} name="password" />
                   <CopyIconButton value={f.password ?? ""} label="password" />
                 </>}>
              <Input id="ssh-pass" type={showPass ? "text" : "password"} value={f.password ?? ""}
                     autoComplete="off" spellCheck={false} className="font-mono"
                     onChange={(e) => setField("password", e.target.value)} />
            </Row>
          ) : (
            <>
              <Row htmlFor="ssh-key" text="Private key"
                   actions={<>
                     <RevealButton shown={showKey} onToggle={() => setShowKey((v) => !v)} name="private key" />
                     <CopyIconButton value={normalizeKey(f.privateKey ?? "")} label="private key" />
                   </>}>
                <textarea id="ssh-key" rows={6} value={f.privateKey ?? ""} spellCheck={false} autoComplete="off"
                          placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                          onChange={(e) => setField("privateKey", e.target.value)}
                          className={`${area} font-mono text-xs leading-relaxed`}
                          style={!showKey ? ({ WebkitTextSecurity: "disc" } as React.CSSProperties) : undefined} />
              </Row>
              <div className="flex items-center gap-2 -mt-1">
                <div className="flex-1 min-w-0 flex items-center gap-1.5 text-xs" aria-live="polite"
                     style={{ color: key.state === "empty" ? "var(--color-text-muted)" : keyTone }}>
                  {key.state !== "empty" && <KeyIcon size={13} className="shrink-0" aria-hidden />}
                  <span className="truncate">{key.state === "empty" ? "Paste a private key or import the file" : key.label}</span>
                </div>
                <Button size="sm" icon={<FileUp size={12} />} onClick={() => { void importKey(); }}>Import file…</Button>
              </div>

              {needsPassphrase && (
                <Row htmlFor="ssh-phrase" text="Key passphrase"
                     hint={key.state === "encrypted" ? "· needed for this key" : "· only if the key is encrypted"}
                     actions={<>
                       <RevealButton shown={showPhrase} onToggle={() => setShowPhrase((v) => !v)} name="passphrase" />
                       <CopyIconButton value={f.passphrase ?? ""} label="passphrase" />
                     </>}>
                  <Input id="ssh-phrase" type={showPhrase ? "text" : "password"} value={f.passphrase ?? ""}
                         autoComplete="off" spellCheck={false} className="font-mono"
                         onChange={(e) => setField("passphrase", e.target.value)} />
                </Row>
              )}
            </>
          )}
        </Section>

        <CollapsibleSection title="Advanced" summary="Jump host, fingerprint, notes" open={advOpen} onToggle={() => setAdvOpen((v) => !v)}>
          <Row htmlFor="ssh-jump" text="Jump host" hint="· optional" actions={<CopyIconButton value={f.jump ?? ""} label="jump host" />}>
            <Input id="ssh-jump" value={f.jump ?? ""} placeholder="user@bastion.example.com" spellCheck={false} autoComplete="off"
                   onChange={(e) => setField("jump", e.target.value.trim())} />
          </Row>
          <Row htmlFor="ssh-fp" text="Host key fingerprint" hint="· optional"
               actions={<CopyIconButton value={f.fingerprint ?? ""} label="fingerprint" />}>
            <Input id="ssh-fp" value={f.fingerprint ?? ""} placeholder="SHA256:…" spellCheck={false} autoComplete="off" className="font-mono"
                   onChange={(e) => setField("fingerprint", e.target.value.trim())} />
          </Row>
          <div>
            <label className={label} htmlFor="ssh-notes">Notes</label>
            <textarea id="ssh-notes" rows={4} value={f.notes ?? ""} className={area}
                      onChange={(e) => setField("notes", e.target.value)} />
          </div>
        </CollapsibleSection>

        <p className="text-xs text-[var(--color-text-muted)]">
          Saved with the vault when you save this tab (Ctrl+S). Copied values are cleared from the clipboard after 20 seconds.
        </p>
      </div>
    </div>
  );
}
