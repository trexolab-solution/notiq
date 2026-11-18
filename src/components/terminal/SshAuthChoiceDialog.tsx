import { KeyRound, Lock, Server } from "lucide-react";
import { Dialog, DialogBody, DialogFooter, DialogButton } from "../ui/Dialog";
import type { SshAuth } from "../../lib/sshEntry";
import { getLastSshAuth, setLastSshAuth } from "../../lib/sshLastAuth";

const optionBtn =
  "w-full text-left px-3 py-2 rounded-md border border-[var(--color-border)] cursor-pointer " +
  "hover:border-[var(--color-primary)] hover:bg-[var(--color-bg-tertiary)] " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)]";

interface Props {
  /** The server's name, for the title. */
  name: string;
  /** `user@host` shown under the question. */
  label: string;
  /** Path of the saved server: the method picked is remembered for it and offered first next time. */
  entryKey?: string;
  onPick: (auth: SshAuth) => void;
  /** Dialog dismissed (Escape, ×). */
  onClose: () => void;
  /** Footer button; "Back" when this sits behind a server list, "Cancel" otherwise. */
  cancelLabel?: string;
  onCancel?: () => void;
}

/** Asked when a saved server has both a private key and a password: which one to sign in with. */
export function SshAuthChoiceDialog({ name, label, entryKey, onPick, onClose, cancelLabel = "Cancel", onCancel }: Props) {
  const last = getLastSshAuth(entryKey);
  const pick = (auth: SshAuth) => { setLastSshAuth(entryKey, auth); onPick(auth); };
  const lastBadge = <span className="ml-auto text-[11px] text-[var(--color-text-muted)]">Last used</span>;
  return (
    <Dialog title={`Sign in to ${name}`} icon={<Server size={16} />} size="sm" onClose={onClose}>
      <DialogBody message="This server has both a private key and a password saved." detail={label}>
        <div className="flex flex-col gap-2 mt-3">
          <button className={optionBtn} onClick={() => pick("key")} autoFocus={last !== "password"}>
            <span className="flex items-center gap-2 text-sm"><KeyRound size={14} /> Private key{last === "key" && lastBadge}</span>
          </button>
          <button className={optionBtn} onClick={() => pick("password")} autoFocus={last === "password"}>
            <span className="flex items-center gap-2 text-sm"><Lock size={14} /> Password{last === "password" && lastBadge}</span>
          </button>
        </div>
      </DialogBody>
      <DialogFooter>
        <DialogButton cancel onClick={onCancel ?? onClose}>{cancelLabel}</DialogButton>
      </DialogFooter>
    </Dialog>
  );
}
