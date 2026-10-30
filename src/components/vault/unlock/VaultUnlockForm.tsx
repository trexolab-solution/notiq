import { Fingerprint } from "lucide-react";
import { DialogButton } from "../../ui/DialogParts";
import { PasswordInput } from "../../ui/PasswordInput";
import { Button } from "../../ui/Button";
import type { VaultUnlock } from "./useVaultUnlock";

interface BodyProps {
  u: VaultUnlock;
  /** Completes "… to {purpose}.", e.g. "open locked notes". */
  purpose: string;
  /** Unique per window, for the label / error wiring. */
  idPrefix: string;
}

/**
 * The body of every vault unlock prompt (main window and autofill window): the master password
 * field, or the Windows Hello view when that is the chosen method, plus the switch between them.
 */
export function VaultUnlockBody({ u, purpose, idPrefix }: BodyProps) {
  const errId = `${idPrefix}-error`;
  const pwId = `${idPrefix}-password`;
  return (
    <div className="flex flex-col gap-3">
      <p className="dlg-detail dlg-detail--block">
        {u.showHello ? `Confirm your identity to ${purpose}.` : `Enter your master password to ${purpose}.`}
      </p>

      {u.showHello ? (
        <div className="flex flex-col items-center gap-3 pt-1">
          <span className="grid place-items-center w-14 h-14 rounded-full bg-[var(--color-bg-tertiary)] text-[var(--color-primary)]" aria-hidden>
            <Fingerprint size={28} strokeWidth={1.6} />
          </span>
          <Button type="button" variant="primary" className="w-full justify-center" autoFocus data-autofocus=""
                  disabled={u.busy} icon={<Fingerprint size={15} />} onClick={() => void u.unlockWithHello()}
                  aria-describedby={u.error ? errId : undefined}>
            {u.busy ? "Waiting for verification…" : "Unlock with PC sign-in"}
          </Button>
        </div>
      ) : (
        <div>
          <label className="block text-xs mb-1 text-[var(--color-text-muted)]" htmlFor={pwId}>Master password</label>
          <PasswordInput id={pwId} autoFocus data-autofocus="" autoComplete="current-password" disabled={u.busy}
                         value={u.password} onChange={(e) => u.setPassword(e.target.value)}
                         aria-invalid={!!u.error} aria-describedby={u.error ? errId : undefined} />
        </div>
      )}

      {u.error && <p id={errId} role="alert" className="text-xs text-[var(--color-danger)]">{u.error}</p>}

      {u.helloOn && (
        <div className={u.showHello ? "text-center" : undefined}>
          <button type="button" className="dlg-link inline-flex items-center gap-1.5" disabled={u.busy}
                  onClick={() => u.setMethod(u.showHello ? "password" : "hello")}>
            {!u.showHello && <Fingerprint size={14} aria-hidden />}
            {u.showHello ? "Use master password" : "Use PC sign-in"}
          </button>
        </div>
      )}
    </div>
  );
}

interface ActionsProps {
  u: VaultUnlock;
  onCancel: () => void;
  /** The submit button's label, e.g. "Unlock" or "Unlock & fill". */
  submitLabel: string;
}

/** Cancel + submit for the unlock step. The Windows Hello view has its own button, so no submit there. */
export function VaultUnlockActions({ u, onCancel, submitLabel }: ActionsProps) {
  return (
    <>
      <DialogButton cancel onClick={onCancel} disabled={u.busy}>Cancel</DialogButton>
      {!u.showHello && (
        <DialogButton type="submit" variant="primary" disabled={u.busy}>{u.busy ? "Unlocking…" : submitLabel}</DialogButton>
      )}
    </>
  );
}
