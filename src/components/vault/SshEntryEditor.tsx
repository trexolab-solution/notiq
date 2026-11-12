import { useCallback, useMemo, useRef, useState } from "react";
import { ArrowDownToLine, CircleCheck, FilePlus2, FileUp, KeyRound, ShieldCheck, SquareTerminal, Terminal, Trash2, TriangleAlert } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { readTextFile, stat } from "@tauri-apps/plugin-fs";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { DropZone } from "../ui/DropZone";
import { useAppStore } from "../../store";
import { useFocusNameOnCreate } from "../../hooks/useFocusNameOnCreate";
import { useVaultStore } from "../../store/vaultStore";
import { useAutoHide } from "../../hooks/useAutoHide";
import { CopyIconButton } from "./CopyIconButton";
import { CustomFieldsEditor } from "./CustomFieldsEditor";
import { AttachmentsPanel } from "./AttachmentsPanel";
import { CollapsibleSection, EntryHeader, EntryLayout, FieldRow as Row, fieldLabel, formColumn, RevealButton, SaveHint, Section, SubGroup, textArea } from "./EntryParts";
import { reinsert, RowIconButton, useAnnouncer, useListFocus, useUndoToast } from "./ListEditor";
import { ImportErrors, KeyFactsRow, KeyFileList, KeyViewerDialog, useKeyFacts, type ImportError } from "./SshKeyParts";
import { GenerateKeyDialog } from "./GenerateKeyDialog";
import { SshAuthChoiceDialog } from "../terminal/SshAuthChoiceDialog";
import { requestSshSession } from "../../lib/sshTerminalRequest";
import { sshLabel, sshMethods } from "../../lib/sshConnect";
import { applyGeneratedKey, defaultComment, type GeneratedKey } from "../../lib/sshKeygen";
import { toast } from "../../lib/toast";
import { fileNameOf } from "../../lib/attachmentLimits";
import { parseSecret, serializeSecret, type SecretEntry } from "../../lib/secretEntry";
import { analyzeKey, normalizeKey, portError, sshCommand, type SshAuth } from "../../lib/sshEntry";
import { keysMatch } from "../../lib/sshKeyInfo";
import {
  byteLength, importSummary, MAX_KEY_FILE_BYTES, parseKeyFiles, rejectReason, roleOf, routeImport, serializeKeyFiles,
  type ImportInput, type KeyFile,
} from "../../lib/sshKeyImport";
import type { Tab } from "../../types";

/** A key textarea with its label and actions on one line above it, and status / facts below. */
function KeyField({ id, text, hint, actions, children, footer }: {
  id: string; text: string; hint?: string; actions: React.ReactNode; children: React.ReactNode; footer?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5" data-key-field={id}>
      <div className="flex items-end gap-2 min-h-7">
        <label className={`${fieldLabel} !mb-0 flex-1 min-w-0 pb-1`} htmlFor={id}>
          {text}{hint && <span className="ml-1.5 opacity-70">{hint}</span>}
        </label>
        <div className="flex items-center gap-1 shrink-0">{actions}</div>
      </div>
      {children}
      {footer}
    </div>
  );
}

type Tone = "ok" | "info" | "bad" | "muted";
const TONE_COLOR: Record<Tone, string> = {
  ok: "var(--color-success)", info: "var(--color-primary)", bad: "var(--color-danger)", muted: "var(--color-text-muted)",
};
function StatusLine({ tone, icon: Icon, children, action }: {
  tone: Tone; icon?: typeof ShieldCheck; children: React.ReactNode; action?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 min-h-6">
      <div className="flex-1 min-w-0 flex items-center gap-1.5 text-xs" style={{ color: TONE_COLOR[tone] }}>
        {Icon && <Icon size={13} className="shrink-0" aria-hidden />}
        <span className="truncate">{children}</span>
      </div>
      {action}
    </div>
  );
}

/** The entry as stored in the tab right now (async handlers must not use a stale render's copy). */
const currentEntry = (tab: Tab): SecretEntry =>
  parseSecret("ssh", useAppStore.getState().tabs.find((t) => t.id === tab.id)?.content ?? tab.content);

type Read = { ok: true; file: ImportInput } | { ok: false; name: string; error: string };

/** Reads one dropped / picked path as a key file, or says why it can't be imported. */
async function readKeyFile(path: string): Promise<Read> {
  const name = fileNameOf(path);
  try {
    const info = await stat(path);
    if (info.isDirectory) return { ok: false, name, error: "Folders can't be imported. Choose the key files inside it" };
    if (info.size > MAX_KEY_FILE_BYTES) return { ok: false, name, error: rejectReason(info.size, "")! };
    let text: string | null = null;
    try { text = await readTextFile(path); } catch { text = null; }
    const why = rejectReason(info.size, text);
    if (why || text === null) return { ok: false, name, error: why ?? "Couldn't read it as text" };
    return { ok: true, file: { name, size: info.size || byteLength(text), value: text.replace(/\r\n?/g, "\n") } };
  } catch (e) {
    return { ok: false, name, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * SSH / server entry: a password, a private key, or both can be saved; both are always shown. Keys can be pasted or
 * imported (button or drag-and-drop): the private and public key land in their fields, where they can
 * be seen and edited, and every other imported file is kept in a list with View / Remove.
 */
export function SshEntryEditor({ tab }: { tab: Tab }) {
  return <SshEntryEditorInner key={tab.id} tab={tab} />;
}

function SshEntryEditorInner({ tab }: { tab: Tab }) {
  const entry = useMemo(() => parseSecret("ssh", tab.content), [tab.content]);
  useFocusNameOnCreate(tab.filePath, "ssh-title");
  const f = entry.fields;
  const files = useMemo(() => parseKeyFiles(f.keyFiles), [f.keyFiles]);

  const [showPass, setShowPass] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [showPhrase, setShowPhrase] = useState(false);
  useAutoHide(showPass, setShowPass);
  useAutoHide(showKey, setShowKey);
  useAutoHide(showPhrase, setShowPhrase);
  // Advanced starts folded, but opens by itself when it already holds something.
  const [advOpen, setAdvOpen] = useState(() => !!(f.jump || f.fingerprint || f.notes));
  const [viewing, setViewing] = useState<KeyFile | null>(null);
  // A viewed private key closes like any other revealed secret (timer, blur, session lock).
  const viewingSecret = !!viewing && roleOf(viewing.name, viewing.value) === "private";
  const closeViewer = useCallback((shown: boolean) => { if (!shown) setViewing(null); }, []);
  useAutoHide(viewingSecret, closeViewer);
  const [confirmClear, setConfirmClear] = useState(false);
  const [errors, setErrors] = useState<ImportError[]>([]);
  const [importing, setImporting] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const busy = useRef(false);

  const { announce, region } = useAnnouncer();
  const { rootRef, focusAfter } = useListFocus<HTMLDivElement>();
  const undoToast = useUndoToast();
  const unlocked = useVaultStore((s) => s.unlocked);
  const active = useAppStore((s) => s.activeTabId === tab.id);

  const save = (next: SecretEntry) => useAppStore.getState().updateTabContent(tab.id, serializeSecret(next));
  /** Applies several field changes in one write, on top of what the tab holds now. */
  const patch = (fields: Record<string, string>) => {
    const cur = currentEntry(tab);
    save({ ...cur, fields: { ...cur.fields, ...fields } });
  };
  const setField = (key: string, value: string) => patch({ [key]: value });
  const setFiles = (next: KeyFile[]) => setField("keyFiles", serializeKeyFiles(next));

  const key = analyzeKey(f.privateKey ?? "");
  const priv = useKeyFacts(f.privateKey ?? "");
  const pub = useKeyFacts(f.publicKey ?? "");
  const pubState = analyzeKey(f.publicKey ?? "").state;
  const match = keysMatch(priv.facts, pub.facts);
  const command = sshCommand(f);
  const portErr = portError(f.port ?? "");
  const needsPassphrase = key.state === "encrypted" || key.state === "empty" || key.state === "invalid" || key.state === "incomplete" || !!f.passphrase;

  // ── Import (button or drop) ───────────────────────────────────────────────

  const importPaths = async (paths: string[]) => {
    if (!paths.length) return;
    if (busy.current) { announce("Still importing. Try again when that finishes."); return; }
    busy.current = true;
    setImporting(true);
    try {
      const reads = await Promise.all(paths.map(readKeyFile));
      const stamp = Date.now();
      const failed: ImportError[] = reads.flatMap((r, i) => (r.ok ? [] : [{ key: `${stamp}-${i}`, name: r.name, error: r.error }]));
      const good = reads.flatMap((r) => (r.ok ? [r.file] : []));
      setErrors(failed); // replaces the previous import's errors
      if (!good.length) {
        announce(failed.length === 1 ? `Couldn't import ${failed[0].name}: ${failed[0].error}.` : `${failed.length} files couldn't be imported.`);
        return;
      }
      const cur = currentEntry(tab);
      const r = routeImport(good, { privateKey: cur.fields.privateKey ?? "", publicKey: cur.fields.publicKey ?? "", files: parseKeyFiles(cur.fields.keyFiles) });
      for (const name of r.overflow) failed.push({ key: `${stamp}-o-${name}`, name, error: "Not added: this entry already keeps the most other key files" });
      setErrors(failed);
      const fields: Record<string, string> = { privateKey: r.privateKey, publicKey: r.publicKey, keyFiles: serializeKeyFiles(r.files) };
      if (r.toPrivate || r.toPublic) fields.auth = "key";
      save({ ...cur, fields: { ...cur.fields, ...fields } });
      const failText = failed.length ? ` ${failed.length} file${failed.length === 1 ? "" : "s"} couldn't be imported.` : "";
      announce(importSummary(r) + failText);
      if (r.toPrivate || r.toPublic || r.added.length) toast.success(r.toPrivate && !r.toPublic && !r.added.length ? "Private key imported" : "Key files imported");
    } finally {
      busy.current = false;
      setImporting(false);
    }
  };

  const pick = async () => {
    if (busy.current) return;
    try {
      const picked = await open({ multiple: true, directory: false, title: "Choose SSH key files (private key, .pub, …)" });
      const paths = typeof picked === "string" ? [picked] : Array.isArray(picked) ? picked : [];
      await importPaths(paths);
    } catch (e) {
      toast.error(`Couldn't open the file picker: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // ── Open in the built-in terminal ──────────────────────────────────────────

  const startTerminal = (method: SshAuth) => {
    setChoosing(false);
    if (!tab.filePath) return;
    requestSshSession({ path: tab.filePath, auth: method, title: currentEntry(tab).title.trim() || sshLabel(f) });
  };

  const openInTerminal = () => {
    const methods = sshMethods(f);
    if (methods.length === 0) { toast.error("Add a private key or a password first"); return; }
    if (methods.length === 1) startTerminal(methods[0]);
    else setChoosing(true); // both saved: ask which one to sign in with
  };

  // ── Generate a new key pair ───────────────────────────────────────────────

  const onGenerated = (gen: GeneratedKey, passphrase: string) => {
    patch(applyGeneratedKey(currentEntry(tab).fields, gen, passphrase));
    setGenerating(false);
    setShowKey(false);
    announce("New key generated. Copy the public key to the server's authorized_keys.");
    toast.success("Key generated. Copy the public key below to the server's authorized_keys.");
  };

  // ── Other key files ────────────────────────────────────────────────────────

  const removeFile = (file: KeyFile, index: number) => {
    setFiles(files.filter((x) => x.id !== file.id));
    focusAfter({ index });
    announce(`Removed ${file.name}. Undo is available for a few seconds.`);
    undoToast(`Removed ${file.name}`, () => {
      const now = parseKeyFiles(currentEntry(tab).fields.keyFiles);
      if (now.some((x) => x.id === file.id)) return;
      setFiles(reinsert(now, index, file));
      announce(`Restored ${file.name}`);
    });
  };

  /** Puts a listed file into its field; the field's old value takes the file's place in the list. */
  const promoteFile = (file: KeyFile, as: "private" | "public") => {
    const cur = currentEntry(tab);
    const field = as === "private" ? "privateKey" : "publicKey";
    const old = cur.fields[field] ?? "";
    const list = parseKeyFiles(cur.fields.keyFiles);
    const i = list.findIndex((x) => x.id === file.id);
    if (i < 0) return;
    const next = list.filter((x) => x.id !== file.id);
    if (old.trim()) next.splice(i, 0, { id: `kf-${Date.now().toString(36)}`, name: `Previous ${as} key`, size: byteLength(old), value: old });
    const value = as === "private" ? normalizeKey(file.value) : normalizeKey(file.value).trimEnd();
    save({ ...cur, fields: { ...cur.fields, [field]: value, keyFiles: serializeKeyFiles(next), auth: "key" } });
    announce(`${file.name} is now the ${as} key${old.trim() ? `; the previous ${as} key is kept in the list` : ""}.`);
  };

  const clearPrivate = () => {
    setConfirmClear(false);
    const cur = currentEntry(tab);
    const old = cur.fields.privateKey ?? "";
    patch({ privateKey: "" });
    announce("Private key cleared. Undo is available for a few seconds.");
    undoToast("Private key cleared", () => { if (!currentEntry(tab).fields.privateKey?.trim()) setField("privateKey", old); });
  };

  const moveToPublic = () => {
    const cur = currentEntry(tab);
    const text = cur.fields.privateKey ?? "";
    const fields: Record<string, string> = { privateKey: "", publicKey: normalizeKey(text).trimEnd() };
    const oldPub = cur.fields.publicKey ?? "";
    if (oldPub.trim() && normalizeKey(oldPub) !== normalizeKey(text)) {
      fields.keyFiles = serializeKeyFiles([...parseKeyFiles(cur.fields.keyFiles),
        { id: `kf-${Date.now().toString(36)}`, name: "Previous public key", size: byteLength(oldPub), value: oldPub }]);
    }
    patch(fields);
    announce("Moved the public key to the Public key field.");
  };

  // ── Status texts ───────────────────────────────────────────────────────────

  const keyTone: Tone = key.state === "ok" ? "ok" : key.state === "encrypted" ? "info" : key.state === "empty" ? "muted" : "bad";
  const KeyIcon = key.state === "ok" ? ShieldCheck : key.state === "encrypted" ? KeyRound : TriangleAlert;
  const pubHasText = !!f.publicKey?.trim();
  const pubBad = pubHasText && pubState !== "public";
  const canDrop = unlocked && active && !tab.vaultLocked;

  return (
    <EntryLayout tab={tab}>
      <div className={formColumn}>
        <EntryHeader icon={Terminal} title="SSH / server" tab={tab} />

        <div>
          <label className={fieldLabel} htmlFor="ssh-title">Name</label>
          <Input id="ssh-title" value={entry.title} placeholder="e.g. Production VPS"
                 onChange={(e) => save({ ...currentEntry(tab), title: e.target.value })} />
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
              <RowIconButton label="Open in terminal" icon={<SquareTerminal size={13} />}
                             tooltip={tab.isDirty ? "Save this entry first (Ctrl+S); the terminal uses the saved version"
                               : tab.vaultLocked ? "Unlock the vault first" : "Open in terminal"}
                             disabled={!!tab.isDirty || !!tab.vaultLocked || !tab.filePath}
                             onClick={openInTerminal} />
            </div>
          )}
        </Section>

        <Section title="Sign in"
                 hint="Save a password, a private key, or both. With both saved, Notiq asks which one to use when you open the server in the terminal.">
          <SubGroup title="Password" hint="Used when you sign in with a password.">
            <Row htmlFor="ssh-pass" text="Password" hideLabel
                 actions={<>
                   <RevealButton shown={showPass} onToggle={() => setShowPass((v) => !v)} name="password" />
                   <CopyIconButton value={f.password ?? ""} label="password" />
                 </>}>
              <Input id="ssh-pass" type={showPass ? "text" : "password"} value={f.password ?? ""}
                     autoComplete="off" spellCheck={false} className="font-mono"
                     onChange={(e) => setField("password", e.target.value)} />
            </Row>
          </SubGroup>

          <SubGroup title="SSH key pair" hint="Paste a key, import the files, or generate a new pair.">
            <div ref={rootRef} className="flex flex-col gap-4">
              <DropZone id={`ssh-keys-${tab.id}`} enabled={canDrop} onDrop={(p) => { void importPaths(p); }}
                        hoverLabel={importing ? "Still importing…" : "Drop to import key files"} hoverIcon={<ArrowDownToLine size={14} />}>
                <div className="flex flex-col gap-1.5 px-3 py-2.5">
                  <div className="flex items-center gap-3">
                  <FileUp size={18} aria-hidden className="shrink-0 text-[var(--color-text-muted)]" />
                  <p className="flex-1 min-w-0 text-sm">Drop key files here</p>
                  <Button size="sm" icon={<FilePlus2 size={12} />} disabled={!canDrop || importing}
                          className="shrink-0 border border-[var(--color-border)] bg-[var(--color-bg-secondary)] !text-[var(--color-text)]" onClick={() => setGenerating(true)}>
                    Generate key…
                  </Button>
                  <Button size="sm" icon={<FileUp size={12} />} loading={importing} loadingText="Importing…"
                          aria-describedby="ssh-import-hint" className="shrink-0 border border-[var(--color-border)] bg-[var(--color-bg-secondary)] !text-[var(--color-text)]" onClick={() => { void pick(); }}>
                    Import files…
                  </Button>
                  </div>
                  <p id="ssh-import-hint" className="text-[11px] pl-[30px] text-[var(--color-text-muted)]">
                    e.g. id_ed25519 and id_ed25519.pub. Each key goes to its field below; any other file is kept in a list.
                  </p>
                </div>
              </DropZone>
              <ImportErrors errors={errors} onDismiss={(k) => setErrors((es) => es.filter((e) => e.key !== k))} />

              <KeyField id="ssh-key" text="Private key"
                        actions={<>
                          <RevealButton shown={showKey} onToggle={() => setShowKey((v) => !v)} name="private key" />
                          <CopyIconButton value={normalizeKey(f.privateKey ?? "")} label="private key" />
                          <RowIconButton danger label="Clear private key" tooltip="Clear private key" icon={<Trash2 size={13} />}
                                         disabled={!f.privateKey?.trim()} onClick={() => setConfirmClear(true)} />
                        </>}
                        footer={<>
                          <StatusLine tone={keyTone} icon={key.state === "empty" ? undefined : KeyIcon}
                                      action={key.state === "public"
                                        ? <Button size="sm" onClick={moveToPublic}>Move to Public key</Button> : undefined}>
                            {key.state === "empty" ? "Paste a private key or import the file" : key.label}
                          </StatusLine>
                          {priv.facts && priv.facts.side === "private" && <KeyFactsRow compact facts={priv.facts} fingerprint={priv.fingerprint} name="Private key" />}
                        </>}>
                <textarea id="ssh-key" rows={6} value={f.privateKey ?? ""} spellCheck={false} autoComplete="off"
                          placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                          aria-describedby="ssh-key-mask"
                          onChange={(e) => setField("privateKey", e.target.value)}
                          className={`${textArea} font-mono text-xs leading-relaxed resize-y`}
                          data-masked={!showKey || undefined}
                          style={!showKey ? ({ WebkitTextSecurity: "disc" } as React.CSSProperties) : undefined} />
                <span id="ssh-key-mask" className="sr-only">{showKey ? "Shown" : "Hidden. Use Show private key to see it."}</span>
              </KeyField>

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

              <KeyField id="ssh-pub" text="Public key" hint="· optional, for authorized_keys"
                        actions={<CopyIconButton value={(f.publicKey ?? "").trim()} label="public key" />}
                        footer={pubHasText && (<>
                          {pubBad ? (
                            <StatusLine tone="bad" icon={TriangleAlert}>
                              {pubState === "ok" || pubState === "encrypted" ? "That's a private key — keep it in the Private key field" : "This doesn't look like a public key"}
                            </StatusLine>
                          ) : match === false ? (
                            <StatusLine tone="bad" icon={TriangleAlert}>Doesn't match the private key — it belongs to a different key pair</StatusLine>
                          ) : match === true ? (
                            <StatusLine tone="ok" icon={CircleCheck}>Matches the private key</StatusLine>
                          ) : null}
                          {pub.facts && pub.facts.side === "public" && <KeyFactsRow facts={pub.facts} fingerprint={pub.fingerprint} name="Public key" />}
                        </>)}>
                <textarea id="ssh-pub" rows={3} value={f.publicKey ?? ""} spellCheck={false} autoComplete="off"
                          placeholder="ssh-ed25519 AAAA… user@host"
                          onChange={(e) => setField("publicKey", e.target.value)}
                          className={`${textArea} font-mono text-xs leading-relaxed resize-y break-all`} />
              </KeyField>

              {files.length > 0 && (
                <div className="flex flex-col gap-1.5" data-key-files="">
                  <div className="flex items-baseline gap-2">
                    <h3 className="text-xs text-[var(--color-text-muted)]">Other key files ({files.length})</h3>
                    <span className="text-[11px] text-[var(--color-text-muted)] opacity-80">Stored encrypted with this entry</span>
                  </div>
                  <KeyFileList files={files} onView={setViewing} onUse={promoteFile} onRemove={removeFile} />
                </div>
              )}
            </div>
          </SubGroup>
        </Section>

        <CollapsibleSection id="ssh-advanced" title="Advanced" summary="Jump host, fingerprint, notes" open={advOpen} onToggle={() => setAdvOpen((v) => !v)}>
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
            <label className={fieldLabel} htmlFor="ssh-notes">Notes</label>
            <textarea id="ssh-notes" rows={4} value={f.notes ?? ""} className={textArea}
                      onChange={(e) => setField("notes", e.target.value)} />
          </div>
        </CollapsibleSection>

        <CustomFieldsEditor value={entry.custom} onChange={(custom) => save({ ...currentEntry(tab), custom })} />
        <AttachmentsPanel tab={tab} />
        <SaveHint />
      </div>
      <div data-ssh-live="">{region}</div>

      {viewing && <KeyViewerDialog file={viewing} onClose={() => setViewing(null)} />}
      {choosing && (
        <SshAuthChoiceDialog
          name={currentEntry(tab).title.trim() || "this server"}
          label={sshLabel(f)}
          onPick={startTerminal}
          onClose={() => setChoosing(false)}
        />
      )}
      {generating && (
        <GenerateKeyDialog
          defaultComment={defaultComment(f)}
          replacing={!!f.privateKey?.trim()}
          onGenerated={onGenerated}
          onClose={() => setGenerating(false)}
        />
      )}
      {confirmClear && (
        <ConfirmDialog
          title="Clear the private key?"
          message="The key is removed from this entry. You can undo this for a few seconds, and earlier saved versions stay in History."
          confirmLabel="Clear key"
          danger
          onConfirm={clearPrivate}
          onCancel={() => setConfirmClear(false)}
        />
      )}
    </EntryLayout>
  );
}

