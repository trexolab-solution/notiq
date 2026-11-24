import { useRef, useState } from "react";
import type { ReactNode } from "react";
import { Dialog, DialogBody, DialogButton, DialogFooter } from "../ui/Dialog";
import { RadioCards, type RadioCardOption } from "../ui/RadioCards";
import { useDropTarget } from "../ui/DropZone";

/**
 * "What do you want to do?": two or more large choices, then Continue. Backup export / import start here, so the
 * choice between a backup of the whole vault and sharing chosen items sits in one place, in the same words both ways.
 * `onDrop` (optional) lets a file dropped on the dialog pick the right choice by itself.
 */
export function ChooseKindDialog<T extends string>({ title, icon, intro, options, initial, onChoose, onClose, onDrop, dropHint }: {
  title: string;
  icon: ReactNode;
  intro?: string;
  options: readonly RadioCardOption<T>[];
  initial: T;
  onChoose: (value: T) => void;
  onClose: () => void;
  /** A file dropped on the dialog (OS drag and drop). */
  onDrop?: (paths: string[]) => void;
  /** The line under the choices that says dropping works. */
  dropHint?: string;
}) {
  const [value, setValue] = useState<T>(initial);
  const rootRef = useRef<HTMLDivElement>(null);
  useDropTarget({
    id: "choose-kind-dialog", modal: true, element: () => rootRef.current?.closest(".dlg-panel") ?? null, enabled: !!onDrop,
    onDrop: (paths) => onDrop?.(paths),
  });

  return (
    <Dialog onClose={onClose} zClassName="z-[80]" size="md" title={title} icon={icon} onPrimary={() => onChoose(value)}>
      <div ref={rootRef} className="contents">
        <DialogBody>
          {intro && <p className="mb-3 text-sm">{intro}</p>}
          <RadioCards<T> label={title} value={value} options={options} onChange={setValue} />
          {dropHint && <p className="mt-3 text-xs text-[var(--color-text-muted)]">{dropHint}</p>}
        </DialogBody>
        <DialogFooter>
          <DialogButton cancel onClick={onClose}>Cancel</DialogButton>
          <DialogButton variant="primary" onClick={() => onChoose(value)}>Continue</DialogButton>
        </DialogFooter>
      </div>
    </Dialog>
  );
}
