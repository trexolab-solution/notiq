import { useState } from "react";
import { Eye, EyeOff, Lock, Trash2, Type } from "lucide-react";
import { Input } from "../ui/Input";
import type { ContextMenuItem } from "../ui/ContextMenu";
import { useAutoHide } from "../../hooks/useAutoHide";
import { CopyIconButton } from "./CopyIconButton";
import { Section } from "./EntryParts";
import {
  AddRowButton, liftedRowClass, listBoxClass, listRowHoverClass, moveTo, reinsert, RowActions,
  rowButtonClass, RowDragHandle, RowIconButton, RowIconSpacer, RowMenuButton, SortableRows, useAnnouncer, useFieldError,
  useLatest, useListFocus, useSortableList, useSortableRow, useUndoToast,
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

/**
 * One field: a drag handle, its name and its value side by side, and a fixed action column
 * (reveal slot · copy · ⋯) so every input ends at the same x.
 */
function FieldRow({ id, field, index, count, error, lifted, sortDescribedBy, onSortKeyDown, onChange, onToggleSecret, onRemove, onEnterLast }: {
  id: string; field: CustomField; index: number; count: number; error: string | null;
  lifted: boolean; sortDescribedBy: string; onSortKeyDown: (e: React.KeyboardEvent) => void;
  onChange: (f: CustomField) => void; onToggleSecret: () => void; onRemove: () => void; onEnterLast: () => void;
}) {
  const [show, setShow] = useState(false);
  useAutoHide(show, setShow);
  // A missing name is only flagged after the user has left the row's inputs once; duplicates show at once.
  const [touched, setTouched] = useState(false);
  const shownError = error && (touched || field.label.trim()) ? error : null;
  const nameErr = useFieldError(shownError);
  const name = fieldName(field, index);
  const last = index === count - 1;
  const sortable = useSortableRow(id);

  const menu: ContextMenuItem[] = [
    field.secret
      ? { type: "item", label: "Show as text", icon: <Type size={14} />, onClick: () => { setShow(false); onToggleSecret(); } }
      : { type: "item", label: "Hide value", icon: <Lock size={14} />, onClick: () => { setShow(false); onToggleSecret(); } },
    SEPARATOR,
    { type: "item", label: "Remove field", icon: <Trash2 size={14} />, danger: true, onClick: onRemove },
  ];

  return (
    <li data-list-row {...sortable.rowProps}
        className={`group flex items-start gap-1 pl-1 pr-2 py-2 ${listRowHoverClass} ${lifted || sortable.isDragging ? liftedRowClass : ""}`}>
      <div className="h-8 flex items-center">
        <RowDragHandle label={`Reorder ${name}`} lifted={lifted} describedBy={sortDescribedBy}
                       onKeyDown={onSortKeyDown} handleProps={sortable.handleProps} />
      </div>
      {/* Name and value side by side, so a list of fields reads like a table. */}
      <div className="flex-1 min-w-0 grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-2 items-start">
        <div className="min-w-0">
          <Input data-row-focus aria-label={`Field name ${index + 1}`} value={field.label}
                 placeholder="Name" maxLength={MAX_CUSTOM_LABEL} spellCheck={false} autoComplete="off"
                 {...nameErr.inputProps} className={nameErr.errorClass}
                 onBlur={() => setTouched(true)}
                 onChange={(e) => onChange({ ...field, label: e.target.value.slice(0, MAX_CUSTOM_LABEL) })}
                 onKeyDown={(e) => {
                   if (e.key === "Enter") {
                     e.preventDefault();
                     e.currentTarget.closest("li")?.querySelector<HTMLInputElement>("[data-field-value]")?.focus();
                   }
                 }} />
          {nameErr.message}
        </div>
        <div className="relative min-w-0">
          {field.secret && (
            <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)] pointer-events-none" title="Hidden value">
              <Lock size={12} aria-hidden />
            </span>
          )}
          <Input data-field-value aria-label={`Value of ${name}`} value={field.value} placeholder="Value" autoComplete="off"
                 spellCheck={false} type={field.secret && !show ? "password" : "text"}
                 className={`min-w-0 ${field.secret ? "font-mono !pl-7" : ""}`}
                 onBlur={() => setTouched(true)}
                 onChange={(e) => onChange({ ...field, value: e.target.value })}
                 onKeyDown={(e) => { if (e.key === "Enter" && last) { e.preventDefault(); onEnterLast(); } }} />
        </div>
      </div>
      <RowActions className="h-8">
        {field.secret ? (
          <RowIconButton pressed={show} label={show ? `Hide value of ${name}` : `Show value of ${name}`}
                         icon={show ? <EyeOff size={13} /> : <Eye size={13} />} onClick={() => setShow((v) => !v)} />
        ) : <RowIconSpacer />}
        <CopyIconButton value={field.value} label={`value of ${name}`} className={rowButtonClass} />
        <RowMenuButton data-row-menu label={`More actions for ${name}`} menuLabel={`Actions for ${name}`} items={menu} />
      </RowActions>
    </li>
  );
}

/** "Custom fields" section: named values, each plain text or hidden (masked, auto-hidden), in the user's order. */
export function CustomFieldsEditor({ value, onChange }: { value: CustomField[]; onChange: (next: CustomField[]) => void }) {
  const { rootRef, focusAfter } = useListFocus();
  const { announce, region } = useAnnouncer();
  const undo = useUndoToast();
  const latest = useLatest({ value, onChange });
  // Bumped on remove / reorder so rows remount: a row never hands its "shown" state to its neighbour.
  // Ids stay fixed while a drag is in progress, which is all the sortable list needs.
  const [version, setVersion] = useState(0);
  const ids = value.map((_, i) => `${i}-${version}`);
  const full = value.length >= MAX_CUSTOM_FIELDS;

  const sort = useSortableList({
    ids, announce,
    nameOf: (i) => fieldName(value[i], i),
    onReorder: (from, to) => { onChange(moveTo(value, from, to)); setVersion((v) => v + 1); },
    focusHandle: (p) => focusAfter({ index: p, selector: "[data-row-handle]" }),
  });

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

  const toggleSecret = (i: number) => {
    const f = value[i];
    onChange(value.map((x, j) => (j === i ? { ...x, secret: !x.secret } : x)));
    announce(f.secret ? `${fieldName(f, i)} is now shown as text` : `${fieldName(f, i)} is now hidden`);
  };

  return (
    <Section title={value.length ? `Custom fields · ${value.length}` : "Custom fields"}
             hint={value.length ? "Hidden values are masked and re-hide themselves; drag a row to reorder." : undefined}>
      <div ref={rootRef} className="flex flex-col gap-2">
        {region}
        {sort.instructions}
        {value.length === 0 ? (
          <p className="text-xs text-[var(--color-text-muted)]">Keep anything else this entry needs: a customer ID, an account number, a security PIN. Hide the ones that are secret.</p>
        ) : (
          <SortableRows sort={sort}>
            <ul aria-label="Custom fields" className={listBoxClass}>
              {sort.order.map((i) => (
                <FieldRow key={ids[i]} id={ids[i]} field={value[i]} index={i} count={value.length}
                          error={fieldNameError(value[i], i, value)}
                          lifted={sort.lifted === i} sortDescribedBy={sort.instructionsId}
                          onSortKeyDown={sort.handleKeyDown(i)}
                          onChange={(nf) => onChange(value.map((x, j) => (j === i ? nf : x)))}
                          onToggleSecret={() => toggleSecret(i)}
                          onRemove={() => remove(i)} onEnterLast={add} />
              ))}
            </ul>
          </SortableRows>
        )}
        <AddRowButton block atLimit={full} limitText={`Up to ${MAX_CUSTOM_FIELDS} custom fields`} onAdd={add}>
          Add field
        </AddRowButton>
      </div>
    </Section>
  );
}
