import { useState } from "react";
import { ArrowDown, ArrowUp, Eye, EyeOff, X } from "lucide-react";
import { Input } from "../ui/Input";
import { Select } from "../ui/Select";
import { useAutoHide } from "../../hooks/useAutoHide";
import { CopyIconButton } from "./CopyIconButton";
import { Section } from "./EntryParts";
import {
  AddRowButton, moveItem, reinsert, RowActions, rowButtonClass, RowIconButton,
  useAnnouncer, useFieldError, useLatest, useListFocus, useUndoToast,
} from "./ListEditor";
import { MAX_CUSTOM_FIELDS, MAX_CUSTOM_LABEL, type CustomField } from "../../lib/customFields";

const TYPE_OPTIONS = [{ value: "text", label: "Text" }, { value: "hidden", label: "Hidden" }];
const EMPTY: CustomField = { label: "", value: "", secret: false };

/** How a row is named in labels and announcements: its name, or its position while it has none. */
export const fieldName = (f: CustomField, i: number) => f.label.trim() || `field ${i + 1}`;

/** Inline problem with a row's name, or null. Missing names only count once the row has a value. */
export function fieldNameError(f: CustomField, i: number, all: CustomField[]): string | null {
  const name = f.label.trim().toLowerCase();
  if (!name) return f.value.trim() ? "Give this field a name" : null;
  return all.some((o, j) => j < i && o.label.trim().toLowerCase() === name) ? "Another field already uses this name" : null;
}

function FieldRow({ field, index, count, error, onChange, onRemove, onMove, onEnterLast }: {
  field: CustomField; index: number; count: number; error: string | null;
  onChange: (f: CustomField) => void; onRemove: () => void; onMove: (dir: -1 | 1) => void; onEnterLast: () => void;
}) {
  const [show, setShow] = useState(false);
  useAutoHide(show, setShow);
  // A missing name is only flagged after the user has left the row's inputs once; duplicates show at once.
  const [touched, setTouched] = useState(false);
  const shownError = error && (touched || field.label.trim()) ? error : null;
  const nameErr = useFieldError(shownError);
  const name = fieldName(field, index);
  const last = index === count - 1;

  return (
    <li data-list-row
        className="flex flex-col gap-1.5 rounded-md p-2 bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
      <div className="flex items-center gap-1.5">
        <Input data-row-focus aria-label={`Name of custom field ${index + 1}`} value={field.label} placeholder="Name, e.g. Customer ID"
               maxLength={MAX_CUSTOM_LABEL} spellCheck={false} {...nameErr.inputProps}
               className={`min-w-0 font-medium ${nameErr.errorClass}`}
               onBlur={() => setTouched(true)}
               onChange={(e) => onChange({ ...field, label: e.target.value.slice(0, MAX_CUSTOM_LABEL) })}
               onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); e.currentTarget.closest("li")?.querySelector<HTMLInputElement>("[data-field-value]")?.focus(); } }} />
        <Select aria-label={`Type of ${name}`} options={TYPE_OPTIONS} value={field.secret ? "hidden" : "text"}
                className="shrink-0 focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/40"
                triggerStyle={{ minWidth: 88, padding: "3px 8px", fontSize: 12, borderRadius: 6, background: "var(--color-bg-tertiary)" }}
                onChange={(v) => { setShow(false); onChange({ ...field, secret: v === "hidden" }); }} />
        <RowActions>
          <RowIconButton data-move="up" label={`Move ${name} up`} tooltip="Move up" icon={<ArrowUp size={13} />}
                         disabled={index === 0} onClick={() => onMove(-1)} />
          <RowIconButton data-move="down" label={`Move ${name} down`} tooltip="Move down" icon={<ArrowDown size={13} />}
                         disabled={last} onClick={() => onMove(1)} />
          <RowIconButton danger label={`Remove ${name}`} tooltip="Remove field" icon={<X size={13} />} onClick={onRemove} />
        </RowActions>
      </div>
      {nameErr.message && <div className="-mt-1">{nameErr.message}</div>}
      <div className="flex items-center gap-1.5">
        <Input data-field-value aria-label={`Value of ${name}`} value={field.value} placeholder="Value" autoComplete="off" spellCheck={false}
               type={field.secret && !show ? "password" : "text"}
               className={`min-w-0 ${field.secret ? "font-mono" : ""}`}
               onBlur={() => setTouched(true)}
               onChange={(e) => onChange({ ...field, value: e.target.value })}
               onKeyDown={(e) => { if (e.key === "Enter" && last) { e.preventDefault(); onEnterLast(); } }} />
        <RowActions>
          {field.secret && (
            <RowIconButton pressed={show} label={show ? `Hide value of ${name}` : `Show value of ${name}`}
                           icon={show ? <EyeOff size={13} /> : <Eye size={13} />} onClick={() => setShow((v) => !v)} />
          )}
          <CopyIconButton value={field.value} label={`value of ${name}`} className={rowButtonClass} />
        </RowActions>
      </div>
    </li>
  );
}

/** "Custom fields" section: named values, each plain text or hidden (masked, auto-hidden), in the user's order. */
export function CustomFieldsEditor({ value, onChange }: { value: CustomField[]; onChange: (next: CustomField[]) => void }) {
  const { rootRef, focusAfter } = useListFocus();
  const { announce, region } = useAnnouncer();
  const undo = useUndoToast();
  const latest = useLatest({ value, onChange });
  // Bumped on remove / move so rows remount: a row never hands its "shown" state to its neighbour.
  const [version, setVersion] = useState(0);
  const full = value.length >= MAX_CUSTOM_FIELDS;

  const add = () => {
    if (full) return;
    onChange([...value, { ...EMPTY }]);
    focusAfter({ index: value.length });
    announce(`Custom field ${value.length + 1} added`);
  };

  const remove = (i: number) => {
    const f = value[i];
    const name = fieldName(f, i);
    onChange(value.filter((_, j) => j !== i));
    setVersion((v) => v + 1);
    focusAfter(value.length > 1 ? { index: i } : "add");
    announce(`Removed ${name}`);
    if (!f.label.trim() && !f.value) return; // nothing worth undoing
    undo(`Removed custom field “${name}”`, () => {
      const l = latest.current;
      if (l.value.length >= MAX_CUSTOM_FIELDS) return;
      l.onChange(reinsert(l.value, i, f));
      setVersion((v) => v + 1);
      announce(`Restored ${name}`);
    });
  };

  const move = (i: number, dir: -1 | 1) => {
    const to = i + dir;
    if (to < 0 || to >= value.length) return;
    onChange(moveItem(value, i, to));
    setVersion((v) => v + 1);
    const same = dir < 0 ? '[data-move="up"]' : '[data-move="down"]';
    const other = dir < 0 ? '[data-move="down"]' : '[data-move="up"]';
    focusAfter({ index: to, selector: `${same}:not([disabled]), ${other}` });
    announce(`${fieldName(value[i], i)} moved to position ${to + 1} of ${value.length}`);
  };

  return (
    <Section title={value.length ? `Custom fields · ${value.length}` : "Custom fields"}>
      <div ref={rootRef} className="flex flex-col gap-2">
        {region}
        {value.length === 0 ? (
          <p className="text-xs text-[var(--color-text-muted)]">
            Add anything else worth keeping with this entry: account numbers, security questions, licence keys…
          </p>
        ) : (
          <ul aria-label="Custom fields" className="flex flex-col gap-2">
            {value.map((f, i) => (
              <FieldRow key={`${i}-${version}`} field={f} index={i} count={value.length}
                        error={fieldNameError(f, i, value)}
                        onChange={(nf) => onChange(value.map((x, j) => (j === i ? nf : x)))}
                        onRemove={() => remove(i)} onMove={(d) => move(i, d)} onEnterLast={add} />
            ))}
          </ul>
        )}
        <div>
          <AddRowButton atLimit={full} limitText={`Up to ${MAX_CUSTOM_FIELDS} custom fields`} onAdd={add}>
            Add field
          </AddRowButton>
        </div>
      </div>
    </Section>
  );
}
