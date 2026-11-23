import { useState } from "react";
import type { FormEvent } from "react";
import { Dices, KeyRound } from "lucide-react";
import { Dialog, DialogBody, DialogButton, DialogFooter } from "../Dialog";
import { Input } from "../Input";
import { PasswordInput } from "../PasswordInput";
import { Button } from "../Button";
import { DEFAULT_SHARE_USER, generateSharePassword, loginProblem } from "../../../lib/webdavShare";

/**
 * Sets the user name and password a phone must enter. Before sharing starts it only remembers them; while sharing it
 * restarts the server with them (the confirm button says so), because the old sign-in stops working at once.
 */
export function WebdavSignInDialog({ user: initialUser, pass: initialPass, running, onSave, onClose }: {
  user: string; pass: string; running: boolean; onSave: (user: string, pass: string) => void; onClose: () => void;
}) {
  const [user, setUser] = useState(initialUser);
  const [pass, setPass] = useState(initialPass);
  const problem = loginProblem(user, pass);
  const unchanged = user.trim() === initialUser && pass === initialPass;
  const isDefault = !user.trim() && !pass;
  const submit = (e: FormEvent) => { e.preventDefault(); if (!problem && !(running && unchanged)) onSave(user.trim(), pass); };

  return (
    <Dialog title="Sign-in for phone sharing" icon={<KeyRound size={16} />} size="sm" onClose={onClose} onSubmit={submit} zClassName="z-[60]">
      <DialogBody>
        <div className="flex flex-col gap-3.5">
          <label className="flex flex-col gap-1.5 text-[13px]">
            <span className="font-medium">User name</span>
            <Input value={user} autoFocus spellCheck={false} autoComplete="off" maxLength={32} placeholder={DEFAULT_SHARE_USER}
                   aria-invalid={!!problem} onChange={(e) => setUser(e.target.value)} />
          </label>
          <div className="flex flex-col gap-1.5 text-[13px]">
            <span className="font-medium">Password</span>
            <div className="flex items-center gap-2">
              <PasswordInput aria-label="Password" value={pass} maxLength={64} placeholder="Random, made when sharing starts" autoComplete="new-password"
                             aria-invalid={!!problem} onChange={(e) => setPass(e.target.value)} />
              <Button size="sm" variant="ghost" icon={<Dices size={13} />} onClick={() => setPass(generateSharePassword())}>Generate</Button>
            </div>
          </div>
          {problem
            ? <p role="alert" className="text-xs text-[var(--color-danger)]">{problem}</p>
            : <p className="text-xs text-[var(--color-text-muted)]">
                At least 8 characters. Leave the password empty for a random one. It isn't saved to disk: Notiq remembers it only until it closes.
              </p>}
          {running && (
            <p className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] px-3 py-2 text-xs text-[var(--color-text-muted)]">
              Sharing is on. Updating restarts it, and every phone must sign in again.
            </p>
          )}
        </div>
      </DialogBody>
      <DialogFooter start={<DialogButton variant="ghost" disabled={isDefault} onClick={() => { setUser(""); setPass(""); }}>Use default</DialogButton>}>
        <DialogButton cancel onClick={onClose}>Cancel</DialogButton>
        <DialogButton variant="primary" type="submit" disabled={!!problem || (running && unchanged)}>{running ? "Update and restart" : "Save"}</DialogButton>
      </DialogFooter>
    </Dialog>
  );
}
