import type { LoginMatch } from "../lib/autofill";
import { passkeyLabel } from "../lib/passkeyEntry";
import type { PasskeyMatch } from "../lib/passkeys";

/** Which login a new passkey is saved on (`pick` -1 = a new login). Uses the same rows as the other choices. */
export function PasskeyTargetChoice({ logins, pick, onPick, disabled }: {
  logins: LoginMatch[]; pick: number; onPick: (index: number) => void; disabled?: boolean;
}) {
  return (
    <div role="radiogroup" aria-label="Save the passkey on" className="af-logins">
      {logins.map((m, i) => (
        <label key={m.path} className="af-login" data-selected={pick === i ? "" : undefined}>
          <input type="radio" name="af-passkey-target" checked={pick === i} disabled={disabled} onChange={() => onPick(i)} />
          <span className="af-login-text">
            <span className="af-login-title">{m.entry.title || m.entry.url}</span>
            <span className="af-login-user">{m.entry.username || "(no username)"}</span>
          </span>
        </label>
      ))}
      <label className="af-login" data-selected={pick === -1 ? "" : undefined}>
        <input type="radio" name="af-passkey-target" checked={pick === -1} disabled={disabled} onChange={() => onPick(-1)} />
        <span className="af-login-text">
          <span className="af-login-title">New login</span>
          <span className="af-login-user">Saved in the Logins folder</span>
        </span>
      </label>
    </div>
  );
}

/** Which saved passkey signs in: its user name and the login that holds it (never the key). */
export function PasskeyChoice({ passkeys, pick, onPick, disabled }: {
  passkeys: PasskeyMatch[]; pick: number; onPick: (index: number) => void; disabled?: boolean;
}) {
  return (
    <div role="radiogroup" aria-label="Saved passkeys" className="af-logins">
      {passkeys.map((m, i) => (
        <label key={`${m.path} ${m.passkey.credentialId}`} className="af-login" data-selected={pick === i ? "" : undefined}>
          <input type="radio" name="af-passkey" checked={pick === i} disabled={disabled} onChange={() => onPick(i)} />
          <span className="af-login-text">
            <span className="af-login-title">{passkeyLabel(m.passkey)}</span>
            <span className="af-login-user">{m.title}</span>
          </span>
        </label>
      ))}
    </div>
  );
}
