import { useState, type KeyboardEvent } from "react";
import { KeyRound, Lock, Server } from "lucide-react";
import { Dialog, DialogBody, DialogFooter, DialogButton } from "../ui/Dialog";
import type { SshAuth } from "../../lib/sshEntry";
import { getLastSshAuth, setLastSshAuth } from "../../lib/sshLastAuth";
import { setAuthPreference } from "../../lib/sshPreferredAuth";
import { openSshSignInSettings } from "../../lib/openSshSignIn";

const optionBtn =
  "w-full text-left px-3 py-2 rounded-md border border-[var(--color-border)] cursor-pointer " +
  "hover:border-[var(--color-primary)] hover:bg-[var(--color-bg-tertiary)] " +
  // `focus`, not `focus-visible`: opened with the mouse, the option Enter would pick must still show.
  "focus:border-[var(--color-primary)] focus:bg-[var(--color-bg-tertiary)] " +
  "focus:outline-2 focus:outline-offset-1 focus:outline-[var(--color-primary)]";

const OPTIONS = [
  { auth: "key", label: "Private key", icon: KeyRound },
  { auth: "password", label: "Password", icon: Lock },
] as const;

const keyCap = "inline-flex items-center justify-center min-w-4 h-4 px-1 rounded border border-[var(--color-border)] text-[10px] font-mono text-[var(--color-text-muted)]";

interface Props {
  /** The server's name, for the title. */
  name: string;
  /** `user@host` shown under the question. */
  label: string;
  /**
   * Path of the saved server: the method picked is remembered for it and offered first next time. With it, the
   * dialog also offers "always use my pick" and a way to the entry's Sign in section.
   */
  entryKey?: string;
  onPick: (auth: SshAuth) => void;
  /** Dialog dismissed (Escape, ×). */
  onClose: () => void;
  /** A step back (to a server list): adds a "Back" button. Without it there is no footer; picking is the action. */
  onBack?: () => void;
}

/**
 * Asked when a saved server has both a private key and a password: which one to sign in with. Picking one signs in.
 * Keyboard: the last used one has the focus; arrows (Home / End) move, Enter or Space picks, 1 / 2 pick at once,
 * Escape closes.
 */
export function SshAuthChoiceDialog({ name, label, entryKey, onPick, onClose, onBack }: Props) {
  const last = getLastSshAuth(entryKey);
  const [always, setAlways] = useState(false);
  const pick = (auth: SshAuth) => {
    setLastSshAuth(entryKey, auth);
    if (always) setAuthPreference(entryKey, auth);
    onPick(auth);
  };
  const first = last === "password" ? "password" : "key";
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const n = Number(e.key) - 1;
    if (OPTIONS[n]) { e.preventDefault(); if (!e.repeat) pick(OPTIONS[n].auth); return; }
    const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const to = e.key === "ArrowDown" || e.key === "ArrowRight" ? (at + 1) % items.length
      : e.key === "ArrowUp" || e.key === "ArrowLeft" ? (at <= 0 ? items.length : at) - 1
      : e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : null;
    if (to === null) return;
    e.preventDefault();
    items[to]?.focus();
  };
  return (
    <Dialog title={`Sign in to ${name}`} icon={<Server size={16} />} size="sm" onClose={onClose}>
      <DialogBody message="This server has both a private key and a password saved." detail={label}>
        <div role="group" aria-label="Sign-in method" className="flex flex-col gap-2 mt-3" onKeyDown={onKeyDown}>
          {OPTIONS.map((o, i) => (
            <button key={o.auth} type="button" className={optionBtn} onClick={() => pick(o.auth)} autoFocus={first === o.auth}
                    aria-keyshortcuts={String(i + 1)}>
              <span className="flex items-center gap-2 text-sm">
                <o.icon size={14} aria-hidden /> {o.label}
                <span className="ml-auto flex items-center gap-2">
                  {last === o.auth && <span className="text-[11px] text-[var(--color-text-muted)]">Last used</span>}
                  <kbd aria-hidden className={keyCap}>{i + 1}</kbd>
                </span>
              </span>
            </button>
          ))}
        </div>
        {entryKey && (
          <div className="mt-3 flex flex-col gap-1.5 rounded-md border border-[var(--color-border)] px-3 py-2.5">
            <label className="flex items-center gap-2.5 text-[13px] cursor-pointer">
              <input type="checkbox" checked={always} onChange={(e) => setAlways(e.target.checked)} className="accent-[var(--color-primary)]" />
              Always use my pick for this server
            </label>
            <p className="text-[11px] text-[var(--color-text-muted)]">
              Kept on this device only. Change it any time in the entry, under Sign in.{" "}
              <button type="button" className="cursor-pointer text-[var(--color-primary)] hover:underline"
                      onClick={() => { onClose(); void openSshSignInSettings(entryKey); }}>
                Open entry
              </button>
            </p>
          </div>
        )}
        <p className="mt-3 text-[11px] text-[var(--color-text-muted)]">↑ ↓ to move · Enter to sign in · Esc to close</p>
      </DialogBody>
      {onBack && (
        <DialogFooter>
          <DialogButton onClick={onBack}>Back</DialogButton>
        </DialogFooter>
      )}
    </Dialog>
  );
}
