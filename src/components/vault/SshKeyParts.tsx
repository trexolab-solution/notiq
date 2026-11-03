import { useEffect, useMemo, useState } from "react";
import { ArrowUpFromLine, Copy, Eye, FileKey2, FileText, KeyRound, Trash2, TriangleAlert, X } from "lucide-react";
import { Dialog, DialogBody, DialogButton, DialogFooter } from "../ui/Dialog";
import { CopyIconButton } from "./CopyIconButton";
import { RowActions, RowIconButton } from "./ListEditor";
import { copySecret } from "../../lib/secureCopy";
import { formatBytes } from "../../lib/vaultBackup";
import { fingerprintOf, keyFacts, type KeyFacts } from "../../lib/sshKeyInfo";
import { roleOf, type KeyFile, type KeyRole } from "../../lib/sshKeyImport";

/** Parsed facts of a key plus its SHA256 fingerprint (computed asynchronously with WebCrypto). */
export function useKeyFacts(text: string): { facts: KeyFacts | null; fingerprint: string | null } {
  const facts = useMemo(() => keyFacts(text), [text]);
  const [fp, setFp] = useState<{ blob: Uint8Array; value: string } | null>(null);
  useEffect(() => {
    const blob = facts?.blob;
    if (!blob) return;
    let live = true;
    fingerprintOf(blob).then((value) => { if (live) setFp({ blob, value }); }, () => {});
    return () => { live = false; };
  }, [facts]);
  // Only report a fingerprint that belongs to the current text (never a stale one while recomputing).
  return { facts, fingerprint: fp && facts?.blob === fp.blob ? fp.value : null };
}

const chip = "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] leading-4 border border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text-muted)]";

/** Type · size, format, encryption, comment and fingerprint as a row of small facts. */
export function KeyFactsRow({ facts, fingerprint, name, compact }: {
  facts: KeyFacts; fingerprint: string | null; name: string;
  /** Leave out format and encryption (the field's status line already says them). */
  compact?: boolean;
}) {
  const typeText = [facts.type, facts.bits ? `${facts.bits}-bit` : null].filter(Boolean).join(" · ");
  return (
    <ul aria-label={`${name} details`} className="flex flex-wrap items-center gap-1.5" data-key-facts="">
      {typeText && <li className={`${chip} font-medium text-[var(--color-text)]`}>{typeText}</li>}
      {!compact && <li className={chip}>{facts.format}</li>}
      {!compact && facts.side === "private" && facts.encrypted !== null && (
        <li className={chip}>{facts.encrypted ? "Passphrase protected" : "Not encrypted"}</li>
      )}
      {facts.comment && <li className={`${chip} max-w-[220px]`}><span className="truncate" title={facts.comment}>{facts.comment}</span></li>}
      {fingerprint && (
        <li className={`${chip} !pr-0.5 max-w-full`}>
          <span className="sr-only">Fingerprint </span>
          <code className="font-mono truncate" title={fingerprint}>{fingerprint}</code>
          <CopyIconButton value={fingerprint} label={`${name} fingerprint`} className="!h-5 !w-5 !p-0 justify-center" />
        </li>
      )}
    </ul>
  );
}

const ROLE_TEXT: Record<KeyRole, string> = { private: "Private key", public: "Public key", other: "Other file" };

/** Extra key files kept with the entry: name, size, what it is, and View / Use / Copy / Remove. */
export function KeyFileList({ files, onView, onUse, onRemove }: {
  files: KeyFile[];
  onView: (f: KeyFile) => void;
  onUse: (f: KeyFile, as: "private" | "public") => void;
  onRemove: (f: KeyFile, index: number) => void;
}) {
  return (
    <ul aria-label="Other key files" className="flex flex-col rounded-md border border-[var(--color-border)] divide-y divide-[var(--color-border)]">
      {files.map((f, i) => {
        const role = roleOf(f.name, f.value);
        const Icon = role === "other" ? FileText : FileKey2;
        const facts = keyFacts(f.value);
        const detail = [ROLE_TEXT[role], facts?.type, formatBytes(f.size)].filter(Boolean).join(" · ");
        return (
          <li key={f.id} data-list-row="" data-key-file={f.id} className="flex items-center gap-2.5 px-2.5 py-1.5">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)]">
              <Icon size={15} aria-hidden />
            </span>
            <div className="flex-1 min-w-0">
              <div className="text-sm truncate" title={f.name}>{f.name}</div>
              <div className="text-[11px] text-[var(--color-text-muted)] truncate">{detail}</div>
            </div>
            <RowActions>
              <RowIconButton data-row-focus="" label={`View ${f.name}`} tooltip="View contents" icon={<Eye size={13} />}
                             onClick={() => onView(f)} />
              {role !== "other" && (
                <RowIconButton label={`Use ${f.name} as the ${role} key`} tooltip={`Use as the ${role} key`}
                               icon={<ArrowUpFromLine size={13} />} onClick={() => onUse(f, role)} />
              )}
              <CopyIconButton value={f.value} label={f.name} className="!p-0 h-7 w-7 justify-center" />
              <RowIconButton danger label={`Remove ${f.name}`} tooltip="Remove file" icon={<Trash2 size={13} />}
                             onClick={() => onRemove(f, i)} />
            </RowActions>
          </li>
        );
      })}
    </ul>
  );
}

export interface ImportError { key: string; name: string; error: string }

/** Files that couldn't be imported, shown inline until dismissed (so nothing fails silently). */
export function ImportErrors({ errors, onDismiss }: { errors: ImportError[]; onDismiss: (key: string) => void }) {
  if (!errors.length) return null;
  return (
    <ul aria-label="Files that couldn't be imported" className="flex flex-col gap-1">
      {errors.map((e) => (
        <li key={e.key} data-import-error=""
            className="flex items-center gap-2.5 rounded-md px-2.5 py-1.5 border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/5">
          <TriangleAlert size={15} aria-hidden className="shrink-0 text-[var(--color-danger)]" />
          <div className="flex-1 min-w-0">
            <div className="text-sm truncate" title={e.name}>{e.name}</div>
            <div className="text-[11px] text-[var(--color-danger)]">{e.error}</div>
          </div>
          <RowActions>
            <RowIconButton label={`Dismiss error for ${e.name}`} tooltip="Dismiss" icon={<X size={13} />} onClick={() => onDismiss(e.key)} />
          </RowActions>
        </li>
      ))}
    </ul>
  );
}

/** Read-only viewer for one key file: its contents (monospace), what it is, and Copy. */
export function KeyViewerDialog({ file, onClose }: { file: KeyFile; onClose: () => void }) {
  const { facts, fingerprint } = useKeyFacts(file.value);
  const role = roleOf(file.name, file.value);
  return (
    <Dialog title={file.name} icon={<KeyRound size={16} />} size="lg" onClose={onClose} data-testid="key-viewer">
      <DialogBody>
        <div className="flex flex-col gap-2.5">
          <p className="text-xs text-[var(--color-text-muted)]">
            {ROLE_TEXT[role]} · {formatBytes(file.size)}
            {role === "private" && " · closes by itself like other revealed secrets"}
          </p>
          {facts && <KeyFactsRow facts={facts} fingerprint={fingerprint} name={file.name} />}
          <pre aria-label={`Contents of ${file.name}`} tabIndex={0}
               className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-all rounded-md px-2.5 py-2 text-xs leading-relaxed font-mono bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/50">
            {file.value}
          </pre>
        </div>
      </DialogBody>
      <DialogFooter>
        <DialogButton icon={<Copy size={13} />} onClick={() => { void copySecret(file.value, file.name); }}>Copy</DialogButton>
        <DialogButton variant="primary" cancel onClick={onClose}>Close</DialogButton>
      </DialogFooter>
    </Dialog>
  );
}
