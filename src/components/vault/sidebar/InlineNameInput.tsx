import { useEffect, useRef, useState } from "react";

interface Props {
  initial: string;
  label: string;
  /** Live validation: an error message, or null when the name is usable. */
  validate: (name: string) => string | null;
  /** Resolve true to close the editor; false keeps it open (e.g. the backend refused). */
  onCommit: (name: string) => Promise<boolean>;
  onCancel: () => void;
  /** Creating something new: committing the suggested name unchanged still counts. */
  isNew?: boolean;
}

/** Inline text field used for rename / new folder / new entry rows. Enter saves, Esc cancels, blur saves. */
export function InlineNameInput({ initial, label, validate, onCommit, onCancel, isNew = false }: Props) {
  const ref = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initial);
  const [touched, setTouched] = useState(false);
  const busy = useRef(false);
  const done = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(0, initial.length); // whole name (".nqv" is never shown)
  }, [initial]);

  const err = touched ? validate(value) : null;

  const commit = async () => {
    if (busy.current || done.current) return;
    const v = value.trim();
    if (!isNew && v === initial.trim()) { done.current = true; onCancel(); return; }
    if (validate(v)) { setTouched(true); ref.current?.focus(); return; }
    busy.current = true;
    const ok = await onCommit(v);
    busy.current = false;
    if (ok) done.current = true;
    else ref.current?.focus();
  };

  return (
    <>
      <input
        ref={ref}
        className={`vt-row-input${err ? " is-invalid" : ""}`}
        value={value}
        aria-label={label}
        aria-invalid={!!err}
        spellCheck={false}
        maxLength={120}
        onChange={(e) => { setValue(e.target.value); setTouched(true); }}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation(); // keep tree navigation keys out of the text field
          if (e.key === "Enter") { e.preventDefault(); void commit(); }
          else if (e.key === "Escape") { e.preventDefault(); done.current = true; onCancel(); }
        }}
        onBlur={() => {
          if (done.current) return;
          // Blur with an invalid or empty name abandons the edit instead of trapping focus.
          if (!value.trim() || validate(value.trim())) { done.current = true; onCancel(); return; }
          void commit();
        }}
      />
      {err && <div className="vt-row-hint" role="alert">{err}</div>}
    </>
  );
}
