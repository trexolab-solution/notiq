import { useState } from "react";
import { TriangleAlert } from "lucide-react";
import { Dialog, DialogBody, DialogButton, DialogFooter, DialogText } from "../ui/Dialog";
import { Input } from "../ui/Input";

export const CONFIRM_WORD = "REPLACE";

/** For replacing a saved secret that can lock the user out: the button works only after typing a word. */
export function TypeToConfirmDialog({ title, message, confirmLabel, onConfirm, onClose }: {
  title: string; message: string; confirmLabel: string; onConfirm: () => void; onClose: () => void;
}) {
  const [typed, setTyped] = useState("");
  const ok = typed.trim() === CONFIRM_WORD;
  return (
    <Dialog role="alertdialog" size="sm" danger title={title} icon={<TriangleAlert size={16} />} zClassName="z-[96000]"
            onClose={onClose} onSubmit={(e) => { e.preventDefault(); if (ok) onConfirm(); }}>
      <DialogBody>
        <div className="flex flex-col gap-3">
          <DialogText>{message}</DialogText>
          <label className="flex flex-col gap-1.5 text-xs text-[var(--color-text-muted)]" htmlFor="confirm-word">
            Type {CONFIRM_WORD} to continue
            <Input id="confirm-word" value={typed} autoFocus spellCheck={false} autoComplete="off" className="font-mono"
                   onChange={(e) => setTyped(e.target.value)} />
          </label>
        </div>
      </DialogBody>
      <DialogFooter>
        <DialogButton cancel onClick={onClose}>Cancel</DialogButton>
        <DialogButton variant="danger" type="submit" disabled={!ok}>{confirmLabel}</DialogButton>
      </DialogFooter>
    </Dialog>
  );
}
