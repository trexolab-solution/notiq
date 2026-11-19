import { useState } from "react";
import type { FormEvent } from "react";
import { Dialog, DialogBody, DialogButton, DialogFooter } from "../../ui/Dialog";
import { Input } from "../../ui/Input";
import { nameProblem } from "../../../lib/sftp";

/** A one-field dialog for a new folder's name or a rename. */
export function NameDialog({ title, label, initial, confirm, onSubmit, onClose }: {
  title: string; label: string; initial: string; confirm: string; onSubmit: (name: string) => void; onClose: () => void;
}) {
  const [value, setValue] = useState(initial);
  const problem = value === initial && initial !== "" ? null : nameProblem(value);
  const submit = (e: FormEvent) => { e.preventDefault(); if (!nameProblem(value) && value.trim() !== initial) onSubmit(value.trim()); };
  return (
    <Dialog title={title} size="sm" onClose={onClose} onSubmit={submit} zClassName="z-[60]">
      <DialogBody>
        <label className="block text-sm mb-1.5" htmlFor="remote-name">{label}</label>
        <Input id="remote-name" value={value} autoFocus spellCheck={false} autoComplete="off"
               onChange={(e) => setValue(e.target.value)} onFocus={(e) => e.currentTarget.select()} />
        {value !== initial && problem && <p className="mt-1.5 text-xs text-[var(--color-danger)]">{problem}</p>}
      </DialogBody>
      <DialogFooter>
        <DialogButton cancel onClick={onClose}>Cancel</DialogButton>
        <DialogButton variant="primary" type="submit" disabled={!!nameProblem(value) || value.trim() === initial}>{confirm}</DialogButton>
      </DialogFooter>
    </Dialog>
  );
}
