import { useState } from "react";
import type { ReactNode } from "react";
import { KeyRound } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { Dialog, DialogBody, DialogFooter, DialogButton, DialogText } from "../ui/Dialog";
import { Input } from "../ui/Input";
import { SegmentedControl } from "../ui/SegmentedControl";
import { RevealButton } from "./EntryParts";
import { validateKeygen, type GeneratedKey, type KeyKind } from "../../lib/sshKeygen";

interface Props {
  defaultComment: string;
  /** The entry already has a private key; generating keeps it in the other-files list. */
  replacing: boolean;
  onGenerated: (key: GeneratedKey, passphrase: string) => void;
  onClose: () => void;
}

const label = "text-xs font-medium text-[var(--color-text)]";
const hint = "text-[11px] text-[var(--color-text-muted)]";
const invalid = "!border-[var(--color-danger,#e5534b)]";

/** One labelled field: required mark, helper text, and an error that replaces the helper. */
function Field({ id, text, required, help, error, action, children }: {
  id: string; text: string; required?: boolean; help?: ReactNode; error?: string; action?: ReactNode; children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2 min-h-[22px]">
        <label htmlFor={id} className={label}>
          {text}
          {required
            ? <span aria-hidden className="ml-0.5 text-[var(--color-danger,#e5534b)]">*</span>
            : <span className="ml-1.5 font-normal text-[var(--color-text-muted)]">Optional</span>}
        </label>
        {action}
      </div>
      {children}
      {error
        ? <p id={`${id}-msg`} className="text-[11px] text-[var(--color-danger,#e5534b)]" role="alert">{error}</p>
        : help && <p id={`${id}-msg`} className={hint}>{help}</p>}
    </div>
  );
}

/** Asks for the key type, a comment (required), an optional passphrase, then has the backend generate the pair. */
export function GenerateKeyDialog({ defaultComment, replacing, onGenerated, onClose }: Props) {
  const [kind, setKind] = useState<KeyKind>("ed25519");
  const [comment, setComment] = useState(defaultComment);
  const [pass, setPass] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [touched, setTouched] = useState({ comment: false, confirm: false });
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");

  const errors = validateKeygen({ comment, pass, confirm });
  const valid = !errors.comment && !errors.confirm;
  // Errors appear once a field was left (or Generate was pressed), not while typing the first character.
  const commentError = touched.comment ? errors.comment : undefined;
  const confirmError = touched.confirm || confirm ? errors.confirm : undefined;

  const run = async () => {
    if (!valid) { setTouched({ comment: true, confirm: true }); return; }
    setBusy(true);
    setFailure("");
    try {
      const key = await invoke<GeneratedKey>("ssh_generate_key", { kind, passphrase: pass || null, comment: comment.trim() });
      onGenerated(key, pass);
    } catch (e) {
      setFailure(typeof e === "string" ? e : e instanceof Error ? e.message : "Couldn't generate the key");
      setBusy(false);
    }
  };

  return (
    <Dialog title="Generate SSH key" icon={<KeyRound size={16} />} size="md" onClose={onClose} dismissable={!busy}
            onSubmit={(e) => { e.preventDefault(); if (!busy) void run(); }}>
      <DialogBody>
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-1.5">
            <span className={label} id="gen-kind-label">Key type</span>
            <SegmentedControl<KeyKind>
              className="self-start"
              aria-label="Key type"
              value={kind}
              onChange={setKind}
              options={[{ value: "ed25519", label: "Ed25519 (recommended)" }, { value: "rsa4096", label: "RSA 4096" }]}
            />
            <p className={hint}>
              {kind === "ed25519"
                ? "Modern, short and fast. Supported by every current server."
                : "For very old servers that don't support Ed25519. Takes a few seconds to generate."}
            </p>
          </div>

          <Field id="gen-comment" text="Comment" required
                 help="A label stored inside the key so you can recognise it later, usually you@computer."
                 error={commentError}>
            <Input id="gen-comment" value={comment} placeholder="you@laptop" spellCheck={false} autoComplete="off"
                   autoFocus maxLength={120} disabled={busy}
                   aria-required="true" aria-invalid={!!commentError || undefined} aria-describedby="gen-comment-msg"
                   className={commentError ? invalid : ""}
                   onChange={(e) => setComment(e.target.value)}
                   onBlur={() => setTouched((t) => ({ ...t, comment: true }))} />
          </Field>

          <div className="flex flex-col gap-4">
            <Field id="gen-pass" text="Passphrase"
                   help="Encrypts the private key. It is saved in this entry so the terminal can fill it in."
                   action={pass ? <RevealButton shown={showPass} onToggle={() => setShowPass((v) => !v)} name="passphrase" /> : undefined}>
              <Input id="gen-pass" type={showPass ? "text" : "password"} value={pass} autoComplete="new-password" spellCheck={false}
                     disabled={busy} aria-describedby="gen-pass-msg" className="font-mono"
                     onChange={(e) => setPass(e.target.value)} />
            </Field>
            {pass && (
              <Field id="gen-confirm" text="Confirm passphrase" required error={confirmError}>
                <Input id="gen-confirm" type={showPass ? "text" : "password"} value={confirm} autoComplete="new-password" spellCheck={false}
                       disabled={busy} aria-required="true" aria-invalid={!!confirmError || undefined} aria-describedby="gen-confirm-msg"
                       className={`font-mono ${confirmError ? invalid : ""}`}
                       onChange={(e) => setConfirm(e.target.value)}
                       onBlur={() => setTouched((t) => ({ ...t, confirm: true }))} />
              </Field>
            )}
          </div>

          {replacing && (
            <DialogText>This entry already has a key. It will be kept in “Other key files”; its passphrase won't be.</DialogText>
          )}
          {failure && <p className="text-xs text-[var(--color-danger,#e5534b)]" role="alert">{failure}</p>}
        </div>
      </DialogBody>
      <DialogFooter>
        <DialogButton cancel onClick={onClose} disabled={busy}>Cancel</DialogButton>
        <DialogButton variant="primary" type="submit" loading={busy} loadingText="Generating…" disabled={!valid}>
          Generate key
        </DialogButton>
      </DialogFooter>
    </Dialog>
  );
}
