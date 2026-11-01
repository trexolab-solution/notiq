import { useState } from "react";
import { ArrowDown, ArrowUp, Eye, EyeOff, Lock, Trash2, Type } from "lucide-react";
import { Input } from "../ui/Input";
import type { ContextMenuItem } from "../ui/ContextMenu";
import { useAutoHide } from "../../hooks/useAutoHide";
import { CopyIconButton } from "./CopyIconButton";
import { Section } from "./EntryParts";
import {
  AddRowButton, InlineLabelInput, listBoxClass, listRowHoverClass, moveItem, reinsert, RowActions, rowButtonClass,
  RowIconButton, RowIconSpacer, RowMenuButton, useAnnouncer, useFieldError, useLatest, useListFocus, useUndoToast,
} from "./ListEditor";
import { MAX_CUSTOM_FIELDS, MAX_CUSTOM_LABEL, type CustomField } from "../../lib/customFields";

const EMPTY: CustomField = { label: "", value: "", secret: false };
const SEPARATOR: ContextMenuItem = { type: "separator" };

/** How a row is named in labels and announcements: its name, or its position while it has none. */
export const fieldName = (f: CustomField, i: number) => f.label.trim() || `field ${i + 1}`;

/** Inline problem with a row's name, or null. Missing names only count once the row has a value. */
export function fieldNameError(f: CustomField, i: number, all: CustomField[]): string | null {
  const name = f.label.trim().toLowerCase();
  if (!name) return f.value.trim() ? "Give this field a name" : null;
  return all.some((o, j) => j < i && o.label.trim().toLowerCase() === name) ? "Another field already uses this name" : null;
}

/** Shown next to a hidden field's name, so its type is visible without opening the menu. */
function HiddenBadge() {
  return (
    <span className="inline-flex items-center gap-1 h-[18px] px-1.5 rounded shrink-0 text-[10px] font-medium uppercase tracking-wide bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)]">
      <Lock size={10} aria-hidden />Hidden
    </span>
  );
}

/**
 * One field, laid out like the form's built-in fields: its name as an editable label, the value full width
 * below it, and a fixed action column (reveal slot · copy · ⋯) so every row's input ends at the same x.
 */
function FieldRow({ field, index, count, error, onChange, onToggleSecret, onRemove, onMove, onEnterLast }: {
  field: CustomField; index: number; count: number; error: string | null;
  onChange: (f: CustomField) => void; onToggleSecret: () => void; onRemove: () => void;
  onMove: (dir: -1 | 1) => void; onEnterLast: () => void;
}) {
  const [show, setShow] = useState(false);
  useAutoHide(show, setShow);
  // A missing name is only flagged after the user has left the row's inputs once; duplicates show at once.
  const [touched, setTouched] = useState(false);
  const shownError = error && (touched || field.label.trim()) ? error : null;
  const nameErr = useFieldError(shownError);
  const name = fieldName(field, index);
  const last = index === count - 1;

  const menu: ContextMenuItem[] = [
    { type: "item", label: "Move up", icon: <ArrowUp size={14} />, disabled: index === 0, onClick: () => onMove(-1) },
    { type: "item", label: "Move down", icon: <ArrowDown size={14} />, disabled: last, onClick: () => onMove(1) },
    SEPARATOR,
    field.secret
      ? { type: "item", label: "Show as text", icon: <Type size={14} />, onClick: () => { setShow(false); onToggleSecret(); } }
      : { type: "item", label: "Hide value", icon: <Lock size={14} />, onClick: () => { setShow(false); onToggleSecret(); } },
    SEPARATOR,
    { type: "item", label: "Remove field", icon: <Trash2 size={14} />, danger: true, onClick: onRemove },
  ];

  return (
    <li data-list-row className={`flex flex-col gap-1 px-3 py-2.5 ${listRowHoverClass}`}>
      <div className="flex items-center gap-1.5 min-w-0">
        <InlineLabelInput data-row-focus aria-label={`Field name ${index + 1}`} value={field.label}
                          placeholder="Field name, e.g. Customer ID" maxLength={MAX_CUSTOM_LABEL} spellCheck={false}
                          {...nameErr.inputProps} className={nameErr.errorClass}
                          onBlur={() => setTouched(true)}
                          onChange={(e) => onChange({ ...field, label: e.target.value.slice(0, MAX_CUSTOM_LABEL) })}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              e.currentTarget.closest("li")?.querySelector<HTMLInputElement>("[data-field-value]")?.focus();
                            }
                          }} />
        {field.secret && <HiddenBadge />}
      </div>
      {nameErr.message && <div className="-mt-1">{nameErr.message}</div>}
      <div className="flex items-center gap-2">
        <Input data-field-value aria-label={`Value of ${name}`} value={field.value} placeholder="Value" autoComplete="off"
               spellCheck={false} type={field.secret && !show ? "password" : "text"}
               className={`min-w-0 ${field.secret ? "font-mono" : ""}`}
               onBlur={() => setTouched(true)}
               onChange={(e) => onChange({ ...field, value: e.target.value })}
               onKeyDown={(e) => { if (e.key === "Enter" && last) { e.preventDefault(); onEnterLast(); } }} />
        <RowActions>
          {field.secret ? (
            <RowIconButton pressed={show} label={show ? `Hide value of ${name}` : `Show value of ${name}`}
                           icon={show ? <EyeOff size={13} /> : <Eye size={13} />} onClick={() => setShow((v) => !v)} />
          ) : <RowIconSpacer />}
          <CopyIconButton value={field.value} label={`value of ${name}`} className={rowButtonClass} />
          <RowMenuButton data-row-menu label={`More actions for ${name}`} menuLabel={`Actions for ${name}`} items={menu} />
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
    // Back on the moved row's ⋯ button, so a second move is one Enter + arrow away.
    focusAfter({ index: to, selector: "[data-row-menu]" });
    announce(`${fieldName(value[i], i)} moved to position ${to + 1} of ${value.length}`);
  };

  const toggleSecret = (i: number) => {
    const f = value[i];
    onChange(value.map((x, j) => (j === i ? { ...x, secret: !x.secret } : x)));
    announce(f.secret ? `${fieldName(f, i)} is now shown as text` : `${fieldName(f, i)} is now hidden`);
  };

  return (
    <Section title={value.length ? `Custom fields · ${value.length}` : "Custom fields"}>
      <div ref={rootRef} className="flex flex-col gap-2">
        {region}
        {value.length === 0 ? (
          <p className="text-xs text-[var(--color-text-muted)]">Add fields like a customer ID or PIN.</p>
        ) : (
          <ul aria-label="Custom fields" className={listBoxClass}>
            {value.map((f, i) => (
              <FieldRow key={`${i}-${version}`} field={f} index={i} count={value.length}
                        error={fieldNameError(f, i, value)}
                        onChange={(nf) => onChange(value.map((x, j) => (j === i ? nf : x)))}
                        onToggleSecret={() => toggleSecret(i)}
                        onRemove={() => remove(i)} onMove={(d) => move(i, d)} onEnterLast={add} />
            ))}
          </ul>
        )}
        <AddRowButton block atLimit={full} limitText={`Up to ${MAX_CUSTOM_FIELDS} custom fields`} onAdd={add}>
          Add field
        </AddRowButton>
      </div>
    </Section>
  );
}
