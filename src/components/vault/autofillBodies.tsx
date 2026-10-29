import { Eye, EyeOff } from "lucide-react";
import { DialogCheckbox } from "../ui/DialogParts";
import { Input } from "../ui/Input";
import { LOGINS_FOLDER, type LoginMatch, type SavePlan, type SaveRequest } from "../../lib/autofill";

/**
 * The interactive parts of the browser-autofill prompts, shared by the small autofill window
 * (src/autofill/AutofillPromptApp.tsx) and the main-window fallback dialogs (AutofillPrompt /
 * AutofillSavePrompt), so both ask exactly the same thing.
 */

export interface FillChoiceProps {
  host: string;
  matches: LoginMatch[];
  pick: number;
  onPick: (index: number) => void;
  trust: boolean;
  onTrust: (on: boolean) => void;
  disabled?: boolean;
}

/** Which saved login to send, plus "Allow this site for 5 minutes". */
export function FillChoice({ host, matches, pick, onPick, trust, onTrust, disabled }: FillChoiceProps) {
  return (
    <>
      <div role="radiogroup" aria-label="Saved logins" className="af-logins">
        {matches.map((m, i) => (
          <label key={m.path} className="af-login" data-selected={pick === i ? "" : undefined}>
            <input type="radio" name="af-login" checked={pick === i} disabled={disabled} onChange={() => onPick(i)} />
            <span className="af-login-text">
              <span className="af-login-title">{m.entry.title || m.entry.url}</span>
              <span className="af-login-user">{m.entry.username || "(no username)"}</span>
            </span>
          </label>
        ))}
      </div>
      <DialogCheckbox
        checked={trust}
        onChange={onTrust}
        label={<>Allow <strong className="af-host-inline">{host}</strong> for 5 minutes</>}
        hint="Fills on this exact site without asking until then, while the vault stays unlocked."
      />
    </>
  );
}

export interface SaveFieldsProps {
  req: SaveRequest;
  plan: SavePlan;
  name: string;
  onName: (name: string) => void;
  nameError: string | null;
  reveal: boolean;
  onReveal: () => void;
  /** Enter in the name field. */
  onEnter: () => void;
  autoFocusName?: boolean;
}

/** What will be written: site, username, masked password (with reveal) and, for a new entry, its name. */
export function SaveFields({ req, plan, name, onName, nameError, reveal, onReveal, onEnter, autoFocusName = true }: SaveFieldsProps) {
  const update = plan.kind === "update";
  return (
    <>
      <dl className="af-fields">
        <dt>Website</dt>
        <dd className="truncate" title={req.host}>{req.host}</dd>
        <dt>Username</dt>
        <dd className="truncate">{req.username || <span className="af-muted">(none)</span>}</dd>
        <dt>Password</dt>
        <dd className="flex items-center gap-1 min-w-0">
          <span className="truncate font-mono">{reveal ? req.password : "•".repeat(Math.min(req.password.length, 16))}</span>
          <button type="button" className="af-icon-btn" aria-label={reveal ? "Hide password" : "Show password"}
                  aria-pressed={reveal} onClick={onReveal}>
            {reveal ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </dd>
        {!update && (
          <>
            <dt><label htmlFor="af-save-name">Name</label></dt>
            <dd>
              <Input id="af-save-name" value={name} maxLength={120} autoFocus={autoFocusName} aria-invalid={!!nameError}
                     aria-describedby={nameError ? "af-save-name-err" : undefined}
                     onChange={(e) => onName(e.target.value)}
                     onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); onEnter(); } }} />
              {nameError && <span id="af-save-name-err" role="alert" className="af-error">{nameError}</span>}
            </dd>
            <dt>Folder</dt>
            <dd>{LOGINS_FOLDER}</dd>
          </>
        )}
      </dl>
      {update && (
        <p className="af-note">
          Updates the password of &ldquo;{plan.target?.entry.title || plan.target?.entry.url}&rdquo;. Other fields stay as they are.
        </p>
      )}
    </>
  );
}
