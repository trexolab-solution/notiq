import { useMemo, useState } from "react";
import { CreditCard, Eye, EyeOff, IdCard, KeyRound, QrCode, Terminal, Wifi, type LucideIcon } from "lucide-react";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { Select } from "../ui/Select";
import { useAppStore } from "../../store";
import { useFocusNameOnCreate } from "../../hooks/useFocusNameOnCreate";
import { useAutoHide } from "../../hooks/useAutoHide";
import { CopyIconButton } from "./CopyIconButton";
import { CustomFieldsEditor } from "./CustomFieldsEditor";
import { AttachmentsPanel } from "./AttachmentsPanel";
import { EntryHeader, EntryLayout, InputWithActions, SaveHint, Section, SectionedForm, fieldLabel, textArea, type FormPanel } from "./EntryParts";
import { isChecked, parseSecret, serializeSecret, SECRET_KINDS, type FieldDef, type SecretEntry } from "../../lib/secretEntry";
import { cardBrand, cardNumberHint, digitsOnly, expiryError, formatCardNumber, formatExpiry } from "../../lib/cardEntry";
import { wifiQrText } from "../../lib/wifiEntry";
import { copySecret } from "../../lib/secureCopy";
import type { Tab } from "../../types";
import { useEntryReadOnly } from "./entryContext";
import { setEntryEditing, useEntryEditing } from "../../lib/entryUi";
import { Tooltip } from "../ui/Tooltip";

/** Applies a field's typing aid (`format`) and length cap. */
function cleanValue(def: FieldDef, v: string): string {
  let out = v;
  if (def.format === "card") out = formatCardNumber(v);
  else if (def.format === "expiry") out = formatExpiry(v);
  else if (def.format === "digits") out = digitsOnly(v);
  return def.maxLength ? out.slice(0, def.maxLength) : out;
}

/** A message under a field: an error (red) or a soft hint (muted). */
function fieldMessage(kind: string, key: string, value: string): { text: string; error: boolean } | null {
  if (kind === "card" && key === "expiry") { const e = expiryError(value); return e ? { text: e, error: true } : null; }
  if (kind === "card" && key === "number") { const h = cardNumberHint(value); return h ? { text: h, error: false } : null; }
  return null;
}

function Field({ kind, def, value, onChange, hideLabel }: {
  kind: string; def: FieldDef; value: string; onChange: (v: string) => void;
  /** The section heading already says what the field is (a lone "Notes" field under a "Notes" section). */
  hideLabel?: boolean;
}) {
  const readOnly = useEntryReadOnly();
  const [show, setShow] = useState(false);
  useAutoHide(show, setShow);
  const id = `se-${def.key}`;

  if (def.type === "checkbox") {
    return (
      <label className="flex items-center gap-2 text-sm cursor-pointer select-none" htmlFor={id}>
        <input id={id} type="checkbox" checked={isChecked(value)} disabled={readOnly} onChange={(e) => onChange(e.target.checked ? "true" : "")}
               className="accent-[var(--color-primary)] w-3.5 h-3.5" />
        {def.label}
      </label>
    );
  }
  if (def.type === "select") {
    const opts = def.options ?? [];
    return (
      <div>
        <span className={fieldLabel} id={`${id}-label`}>{def.label}</span>
        <Select aria-label={def.label} disabled={readOnly} value={value || opts[0] || ""} onChange={onChange}
                options={opts.map((o) => ({ value: o, label: o }))} />
      </div>
    );
  }

  const secret = def.type === "secret" || def.type === "multiline-secret";
  const multi = def.type === "multiline" || def.type === "multiline-secret";
  const msg = fieldMessage(kind, def.key, value);
  // Card numbers are shown grouped but copied as plain digits (what payment forms accept).
  const copyValue = def.format === "card" ? digitsOnly(value) : value;
  return (
    <div>
      <label className={hideLabel ? "sr-only" : fieldLabel} htmlFor={id}>{def.label}</label>
      {/* Reveal / copy sit inside the field's right edge. */}
      <InputWithActions top={multi} actions={(secret || def.type !== "multiline") ? (
        <>
          {secret && (
            <Button size="sm" aria-label={show ? `Hide ${def.label.toLowerCase()}` : `Show ${def.label.toLowerCase()}`} aria-pressed={show}
                    className="!p-0 h-7 w-7 justify-center shrink-0 aria-pressed:text-[var(--color-primary)]"
                    icon={show ? <EyeOff size={13} /> : <Eye size={13} />} onClick={() => setShow((v) => !v)} />
          )}
          {def.type !== "multiline" && <CopyIconButton value={copyValue} label={def.label.toLowerCase()} />}
        </>
      ) : undefined}>
        {multi ? (
          <textarea id={id} readOnly={readOnly} rows={def.type === "multiline-secret" ? 6 : 4} value={value} placeholder={def.placeholder}
                    onChange={(e) => onChange(cleanValue(def, e.target.value))} spellCheck={false} autoComplete="off"
                    className={`${textArea} ${secret ? "font-mono" : ""}`}
                    style={secret && !show ? ({ WebkitTextSecurity: "disc" } as React.CSSProperties) : undefined} />
        ) : (
          <Input id={id} readOnly={readOnly} type={secret && !show ? "password" : def.inputType ?? "text"} value={value} placeholder={def.placeholder}
                 onChange={(e) => onChange(cleanValue(def, e.target.value))} spellCheck={false} autoComplete="off"
                 inputMode={def.format ? "numeric" : undefined} aria-invalid={msg?.error || undefined}
                 className={`${secret || def.format ? "font-mono" : ""} ${msg?.error ? "!border-[var(--color-danger)]" : ""}`} />
        )}
      </InputWithActions>
      {msg && (
        <p className="text-xs mt-1" style={{ color: msg.error ? "var(--color-danger)" : "var(--color-text-muted)" }}>{msg.text}</p>
      )}
    </div>
  );
}

const ICONS: Record<string, LucideIcon> = {
  ssh: Terminal, secret: KeyRound, card: CreditCard, wifi: Wifi, identity: IdCard,
};

/** Example names that show what a good title looks like for each kind. */
const NAME_PLACEHOLDER: Record<string, string> = {
  secret: "e.g. OpenAI production key", card: "e.g. Personal Visa", wifi: "e.g. Home Wi-Fi", identity: "e.g. Home address",
};

/** Fields hidden for the current state (e.g. no password on an open Wi-Fi network). */
const hiddenField = (e: SecretEntry, key: string) => e.kind === "wifi" && key === "password" && e.fields.security === "Open";

/** Schema-driven editor for API-key, payment-card, Wi-Fi and identity vault entries. */
export function SecretEntryEditor({ tab, kind }: { tab: Tab; kind: string }) {
  const def = SECRET_KINDS[kind];
  const entry = useMemo(() => parseSecret(kind, tab.content), [kind, tab.content]);
  useFocusNameOnCreate(tab.filePath, "se-title", () => setEntryEditing(tab.id, true));
  const readOnly = !useEntryEditing(tab);
  if (!def) return null;
  const save = (next: SecretEntry) => useAppStore.getState().updateTabContent(tab.id, serializeSecret(next));
  const Icon = ICONS[kind] ?? KeyRound;
  const brand = kind === "card" ? cardBrand(entry.fields.number ?? "") : null;
  const qr = kind === "wifi" ? wifiQrText(entry.fields) : null;

  // Consecutive fields with the same `group` share one section; a half-width field pairs up with its neighbour.
  const groups: { title: string; fields: FieldDef[] }[] = [];
  for (const f of def.fields.filter((f) => !f.internal && !hiddenField(entry, f.key))) {
    const title = f.group ?? "";
    const last = groups[groups.length - 1];
    if (last && last.title === title) last.fields.push(f); else groups.push({ title, fields: [f] });
  }

  const nameField = (
    <div>
      <label className={fieldLabel} htmlFor="se-title">Name</label>
      <Input id="se-title" readOnly={readOnly} value={entry.title} onChange={(e) => save({ ...entry, title: e.target.value })}
             placeholder={NAME_PLACEHOLDER[kind]} />
    </div>
  );

  const fieldsOf = (g: { title: string; fields: FieldDef[] }) => (
    // Two columns when the form is wide enough; one when it is narrow (half-width fields stack).
    <div className="grid grid-cols-1 @md:grid-cols-2 gap-x-3 gap-y-4">
      {g.fields.map((f) => (
        <div key={f.key} className={f.width ? "@md:col-span-1 min-w-0" : "@md:col-span-2 min-w-0"}>
          <Field kind={kind} def={f} value={entry.fields[f.key] ?? ""} hideLabel={f.label === g.title}
                 onChange={(v) => save({ ...entry, fields: { ...entry.fields, [f.key]: v } })} />
        </div>
      ))}
      {kind === "wifi" && g.title === "Network" && (
        <div className="@md:col-span-2 flex flex-wrap items-center gap-x-2 gap-y-1.5">
          <Tooltip content="Enter the network name first" disabled={!!qr}><span className="inline-flex"><Button size="sm" icon={<QrCode size={12} />} disabled={!qr}
                  onClick={() => { if (qr) void copySecret(qr, "Wi-Fi QR text"); }}>
            Copy Wi-Fi QR text
          </Button></span></Tooltip>
          <span className="text-[11px] text-[var(--color-text-muted)]">Paste into any QR generator so phones can join by scanning.</span>
        </div>
      )}
    </div>
  );

  // Each group of fields is a section of its own (the Name goes with the first); Notes join the custom fields.
  const main = groups.filter((g) => g.title !== "Notes");
  const notes = groups.find((g) => g.title === "Notes");
  const panels: FormPanel[] = main.map((g, i) => ({
    id: `g-${g.title || "main"}`, label: g.title || def.label,
    content: (
      <Section title={g.title || def.label}>
        {i === 0 && nameField}
        {fieldsOf(g)}
      </Section>
    ),
  }));
  if (!main.length) panels.push({ id: "g-main", label: def.label, content: <Section title={def.label}>{nameField}</Section> });
  panels.push({
    id: "details", label: "Details", badge: entry.custom.length,
    content: (<>
      {notes && <Section title="Notes">{fieldsOf(notes)}</Section>}
      <CustomFieldsEditor value={entry.custom} onChange={(custom) => save({ ...entry, custom })} />
    </>),
  });
  panels.push({ id: "files", label: "Attachments", content: <AttachmentsPanel tab={tab} /> });

  return (
    <EntryLayout tab={tab}>
      <SectionedForm header={<EntryHeader icon={Icon} title={def.label} tab={tab} badge={brand} />}
                     panels={panels} footer={<SaveHint />} />
    </EntryLayout>
  );
}
