import { Eye, EyeOff, Info } from "lucide-react";
import type { ReactNode } from "react";
import { Tooltip } from "../ui/Tooltip";
import { DialogCheckbox } from "../ui/DialogParts";
import { Input } from "../ui/Input";
import { Select } from "../ui/Select";
import {
  cardTitle, hasSaveChoice, LOGINS_FOLDER, saveCandidateLabel, type CardMatch, type LoginMatch, type SavePlan, type SaveRequest,
} from "../../lib/autofill";
import { cardBrand, cardExpired, maskCardNumber } from "../../lib/cardEntry";
import { identityTitle, type IdentityMatch } from "../../lib/autofill";
import { identitySummary } from "../../lib/identityEntry";

/**
 * The interactive parts of the browser-autofill prompts, shared by the small autofill window
 * (src/autofill/AutofillPromptApp.tsx) and the main-window fallback dialogs (AutofillPrompt /
 * AutofillSavePrompt), so both ask exactly the same thing.
 */

/**
 * One choice row: the radio label plus, when `onDetails` is given, a "details" quick action beside it.
 * The button sits outside the label, so pressing it neither picks the row nor fills anything.
 */
function ChoiceRow({ name, title, sub, index, pick, onPick, onDetails, disabled }: {
  name: string; title: ReactNode; sub: ReactNode; index: number; pick: number;
  onPick: (index: number) => void; onDetails?: (index: number) => void; disabled?: boolean;
}) {
  const label = (
    <label className="af-login" data-selected={pick === index ? "" : undefined}>
      <input type="radio" name={name} checked={pick === index} disabled={disabled} onChange={() => onPick(index)} />
      <span className="af-login-text">
        <span className="af-login-title">{title}</span>
        <span className="af-login-user">{sub}</span>
      </span>
    </label>
  );
  if (!onDetails) return label;
  const what = typeof title === "string" && title ? title : "this entry";
  return (
    <div className="af-login-row">
      {label}
      <Tooltip content="View details">
        <button type="button" className="af-details-btn" aria-label={`View details of ${what}`} data-af-details={index}
                disabled={disabled}
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); onDetails(index); }}>
          <Info size={14} aria-hidden />
        </button>
      </Tooltip>
    </div>
  );
}

export interface FillChoiceProps {
  host: string;
  matches: LoginMatch[];
  pick: number;
  onPick: (index: number) => void;
  trust: boolean;
  onTrust: (on: boolean) => void;
  disabled?: boolean;
  /** Opens the read-only details view of row `index` (the autofill window only). */
  onDetails?: (index: number) => void;
}

/** Which saved login to send, plus "Allow this site for 5 minutes". */
export function FillChoice({ host, matches, pick, onPick, trust, onTrust, disabled, onDetails }: FillChoiceProps) {
  return (
    <>
      <div role="radiogroup" aria-label="Saved logins" className="af-logins">
        {matches.map((m, i) => (
          <ChoiceRow key={m.path} name="af-login" index={i} pick={pick} onPick={onPick} onDetails={onDetails} disabled={disabled}
                     title={m.entry.title || m.entry.url} sub={m.entry.username || "(no username)"} />
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

export interface CardChoiceProps {
  cards: CardMatch[];
  pick: number;
  onPick: (index: number) => void;
  disabled?: boolean;
  onDetails?: (index: number) => void;
}

/** Which saved card to send: title, brand, masked number and expiry (never the full number or the CVC). */
export function CardChoice({ cards, pick, onPick, disabled, onDetails }: CardChoiceProps) {
  return (
    <div role="radiogroup" aria-label="Saved cards" className="af-logins">
      {cards.map((c, i) => {
        const brand = cardBrand(c.fill.number);
        const exp = c.fill.exp_month ? `${c.fill.exp_month}/${c.fill.exp_year.slice(-2)}` : "";
        const expired = cardExpired(c.fill);
        return (
          <ChoiceRow key={c.path} name="af-card" index={i} pick={pick} onPick={onPick} onDetails={onDetails} disabled={disabled}
                     title={cardTitle(c)}
                     sub={[brand, maskCardNumber(c.fill.number), exp && (expired ? `expired ${exp}` : `exp ${exp}`)].filter(Boolean).join(" · ")} />
        );
      })}
    </div>
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
  /** Several logins share this username on the site: the user picked candidate `index` to update. */
  onTarget?: (index: number) => void;
  /** "Update an existing login instead" (back from Save as new). */
  onSaveAsNew?: (on: boolean) => void;
  disabled?: boolean;
}

/**
 * What will be written: site, username, masked password (with reveal) and, for a new entry, its name.
 * When several saved logins have this username on the site, an "Update" picker chooses which one
 * (the most recently used is pre-selected); the footer's "Save as new" switches to a new entry.
 */
export function SaveFields({
  req, plan, name, onName, nameError, reveal, onReveal, onEnter, autoFocusName = true, onTarget, onSaveAsNew, disabled,
}: SaveFieldsProps) {
  const update = plan.kind === "update";
  const choice = hasSaveChoice(plan) ? plan.candidates ?? [] : [];
  const targetIdx = plan.target ? choice.indexOf(plan.target) : -1;
  return (
    <>
      <dl className="af-fields">
        <dt>Website</dt>
        <dd className="truncate" title={req.host}>{req.host}</dd>
        <dt>Username</dt>
        <dd className="truncate">{req.username || <span className="af-muted">(none)</span>}</dd>
        {update && choice.length > 0 && (
          <>
            <dt id="af-save-target-label">Update</dt>
            <dd>
              <Select
                aria-label="Login to update"
                value={String(Math.max(0, targetIdx))}
                onChange={(v) => onTarget?.(Number(v))}
                options={choice.map((m, i) => ({ value: String(i), label: saveCandidateLabel(m, choice) }))}
                disabled={disabled}
                triggerStyle={{ width: "100%", minWidth: 0, padding: "4px 10px", fontSize: 12 }}
              />
            </dd>
          </>
        )}
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
      {!update && hasSaveChoice(plan) && onSaveAsNew && (
        <p className="af-note">
          Saves a new login next to the {plan.candidates?.length} you already have for this username.{" "}
          <button type="button" className="af-link-btn" disabled={disabled} onClick={() => onSaveAsNew(false)}>
            Update an existing login instead
          </button>
        </p>
      )}
    </>
  );
}

export interface IdentityChoiceProps {
  identities: IdentityMatch[];
  pick: number;
  onPick: (index: number) => void;
  disabled?: boolean;
  onDetails?: (index: number) => void;
}

/** Which saved identity to send: its title plus name and city (the rest is only sent once allowed). */
export function IdentityChoice({ identities, pick, onPick, disabled, onDetails }: IdentityChoiceProps) {
  return (
    <div role="radiogroup" aria-label="Saved identities" className="af-logins">
      {identities.map((m, i) => (
        <ChoiceRow key={m.path} name="af-identity" index={i} pick={pick} onPick={onPick} onDetails={onDetails} disabled={disabled}
                   title={identityTitle(m)} sub={identitySummary(m.fill) || "(no name)"} />
      ))}
    </div>
  );
}