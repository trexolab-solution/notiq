import { useMemo, useState } from "react";
import { CreditCard, Eye, EyeOff, KeyRound, QrCode, Terminal, Wifi, type LucideIcon } from "lucide-react";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { Select } from "../ui/Select";
import { useAppStore } from "../../store";
import { useAutoHide } from "../../hooks/useAutoHide";
import { CopyIconButton } from "./CopyIconButton";
import { CustomFieldsEditor } from "./CustomFieldsEditor";
import { AttachmentsPanel } from "./AttachmentsPanel";
import { EntryHeader, SaveHint, fieldLabel, textArea } from "./EntryParts";
import { isChecked, parseSecret, serializeSecret, SECRET_KINDS, type FieldDef, type SecretEntry } from "../../lib/secretEntry";
import { cardBrand, cardNumberHint, digitsOnly, expiryError, formatCardNumber, formatExpiry } from "../../lib/cardEntry";
import { wifiQrText } from "../../lib/wifiEntry";
import { copySecret } from "../../lib/secureCopy";
import type { Tab } from "../../types";

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

function Field({ kind, def, value, onChange }: { kind: string; def: FieldDef; value: string; onChange: (v: string) => void }) {
  const [show, setShow] = useState(false);
  useAutoHide(show, setShow);
  const id = `se-${def.key}`;

  if (def.type === "checkbox") {
    return (
      <label className="flex items-center gap-2 text-sm cursor-pointer select-none" htmlFor={id}>
        <input id={id} type="checkbox" checked={isChecked(value)} onChange={(e) => onChange(e.target.checked ? "true" : "")}
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
        <Select aria-label={def.label} value={value || opts[0] || ""} onChange={onChange}
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
      <label className={fieldLabel} htmlFor={id}>{def.label}</label>
      <div className="flex items-start gap-2">
        {multi ? (
          <textarea id={id} rows={def.type === "multiline-secret" ? 6 : 4} value={value} placeholder={def.placeholder}
                    onChange={(e) => onChange(cleanValue(def, e.target.value))} spellCheck={false} autoComplete="off"
                    className={`${textArea} ${secret ? "font-mono" : ""}`}
                    style={secret && !show ? ({ WebkitTextSecurity: "disc" } as React.CSSProperties) : undefined} />
        ) : (
          <Input id={id} type={secret && !show ? "password" : "text"} value={value} placeholder={def.placeholder}
                 onChange={(e) => onChange(cleanValue(def, e.target.value))} spellCheck={false} autoComplete="off"
                 inputMode={def.format ? "numeric" : undefined} aria-invalid={msg?.error || undefined}
                 className={`${secret || def.format ? "font-mono" : ""} ${msg?.error ? "!border-[var(--color-danger)]" : ""}`} />
        )}
        {secret && (
          <Button size="sm" aria-label={show ? `Hide ${def.label.toLowerCase()}` : `Show ${def.label.toLowerCase()}`} aria-pressed={show}
                  icon={show ? <EyeOff size={12} /> : <Eye size={12} />} onClick={() => setShow((v) => !v)} />
        )}
        {def.type !== "multiline" && <CopyIconButton value={copyValue} label={def.label.toLowerCase()} />}
      </div>
      {msg && (
        <p className="text-xs mt-1" style={{ color: msg.error ? "var(--color-danger)" : "var(--color-text-muted)" }}>{msg.text}</p>
      )}
    </div>
  );
}

const ICONS: Record<string, LucideIcon> = {
  ssh: Terminal, secret: KeyRound, card: CreditCard, wifi: Wifi,
};

/** Fields hidden for the current state (e.g. no password on an open Wi-Fi network). */
const hiddenField = (e: SecretEntry, key: string) => e.kind === "wifi" && key === "password" && e.fields.security === "Open";

/** Schema-driven editor for API-key, payment-card and Wi-Fi vault entries. */
export function SecretEntryEditor({ tab, kind }: { tab: Tab; kind: string }) {
  const def = SECRET_KINDS[kind];
  const entry = useMemo(() => parseSecret(kind, tab.content), [kind, tab.content]);
  if (!def) return null;
  const save = (next: SecretEntry) => useAppStore.getState().updateTabContent(tab.id, serializeSecret(next));
  const Icon = ICONS[kind] ?? KeyRound;
  const brand = kind === "card" ? cardBrand(entry.fields.number ?? "") : null;
  const qr = kind === "wifi" ? wifiQrText(entry.fields) : null;

  return (
    <div data-tour="editor" className="flex-1 min-h-0 overflow-y-auto bg-[var(--color-editor-bg)]">
      <div className="max-w-xl mx-auto px-6 py-8 flex flex-col gap-4 text-[var(--color-text)]">
        <EntryHeader icon={Icon} title={def.label} tab={tab} badge={brand} />
        <div>
          <label className={fieldLabel} htmlFor="se-title">Name</label>
          <Input id="se-title" value={entry.title} onChange={(e) => save({ ...entry, title: e.target.value })} />
        </div>
        {def.fields.filter((f) => !hiddenField(entry, f.key)).map((f) => (
          <Field key={f.key} kind={kind} def={f} value={entry.fields[f.key] ?? ""}
                 onChange={(v) => save({ ...entry, fields: { ...entry.fields, [f.key]: v } })} />
        ))}
        {kind === "wifi" && (
          <div className="flex items-center gap-2">
            <Button size="sm" icon={<QrCode size={12} />} disabled={!qr}
                    title={qr ? undefined : "Enter the network name first"}
                    onClick={() => { if (qr) void copySecret(qr, "Wi-Fi QR text"); }}>
              Copy Wi-Fi QR text
            </Button>
            <span className="text-[11px] text-[var(--color-text-muted)]">Paste into any QR generator so phones can join by scanning.</span>
          </div>
        )}
        <CustomFieldsEditor value={entry.custom} onChange={(custom) => save({ ...entry, custom })} />
        <AttachmentsPanel tab={tab} />
        <SaveHint />
      </div>
    </div>
  );
}
