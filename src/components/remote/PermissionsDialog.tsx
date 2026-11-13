import { useState } from "react";
import type { FormEvent } from "react";
import { Dialog, DialogBody, DialogButton, DialogFooter } from "../ui/Dialog";
import { Input } from "../ui/Input";
import { modeOctal, modeString, parseOctalMode } from "../../lib/sftp";

const WHO = ["Owner", "Group", "Others"] as const;
const WHAT = [{ label: "Read", bit: 4 }, { label: "Write", bit: 2 }, { label: "Execute", bit: 1 }] as const;

/** The permissions of a file or folder as a grid of checkboxes plus the octal number (`755`); applying runs chmod. */
export function PermissionsDialog({ name, mode, onApply, onClose }: {
  name: string;
  mode: number | null;
  onApply: (mode: number) => void;
  onClose: () => void;
}) {
  const original = mode ?? 0o644;
  // Special bits (setuid, setgid, sticky) are kept as they are; the grid edits the nine `rwx` bits.
  const special = original & 0o7000;
  const [bits, setBits] = useState(original & 0o777);
  const [octal, setOctal] = useState(modeOctal(original));
  const bad = parseOctalMode(octal) === null;

  const toggle = (shift: number, bit: number) => {
    const next = bits ^ (bit << shift);
    setBits(next); setOctal(modeOctal(next));
  };
  const typed = (text: string) => {
    setOctal(text);
    const m = parseOctalMode(text);
    if (m !== null) setBits(m & 0o777);
  };
  const submit = (e: FormEvent) => { e.preventDefault(); if (!bad) onApply(special | bits); };

  return (
    <Dialog title={`Permissions · ${name}`} size="sm" onClose={onClose} onSubmit={submit} zClassName="z-[60]">
      <DialogBody>
        <table className="w-full text-sm" aria-label="Permissions">
          <thead>
            <tr className="text-xs text-[var(--color-text-muted)]">
              <th className="text-left font-medium pb-1.5" />
              {WHAT.map((w) => <th key={w.label} className="font-medium pb-1.5">{w.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {WHO.map((who, i) => {
              const shift = (2 - i) * 3;
              return (
                <tr key={who}>
                  <td className="py-1 pr-3">{who}</td>
                  {WHAT.map((w) => (
                    <td key={w.label} className="text-center py-1">
                      <input type="checkbox" className="cursor-pointer" aria-label={`${who} ${w.label.toLowerCase()}`}
                             checked={(bits & (w.bit << shift)) !== 0} onChange={() => toggle(shift, w.bit)} />
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="mt-4 flex items-center gap-3">
          <label htmlFor="remote-octal" className="text-sm">Octal</label>
          <Input id="remote-octal" className="!w-24 font-mono" value={octal} spellCheck={false} autoComplete="off" inputMode="numeric"
                 onChange={(e) => typed(e.target.value)} />
          <span className="text-xs font-mono text-[var(--color-text-muted)]">{modeString(special | bits)}</span>
        </div>
        {bad && <p className="mt-1.5 text-xs text-[var(--color-danger)]">Use 3 or 4 octal digits, like 644 or 755.</p>}
      </DialogBody>
      <DialogFooter>
        <DialogButton cancel onClick={onClose}>Cancel</DialogButton>
        <DialogButton variant="primary" type="submit" disabled={bad || (special | bits) === original}>Apply</DialogButton>
      </DialogFooter>
    </Dialog>
  );
}
