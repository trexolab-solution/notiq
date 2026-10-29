import { useState } from "react";
import { Lock, LockOpen, Plus, X } from "lucide-react";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { Tooltip } from "../ui/Tooltip";
import { useAutoHide } from "../../hooks/useAutoHide";
import { CopyIconButton } from "./CopyIconButton";
import { RevealButton, Section } from "./EntryParts";
import { MAX_CUSTOM_FIELDS, MAX_CUSTOM_LABEL, type CustomField } from "../../lib/customFields";

function FieldRow({ field, index, onChange, onRemove }: {
  field: CustomField; index: number; onChange: (f: CustomField) => void; onRemove: () => void;
}) {
  const [show, setShow] = useState(false);
  useAutoHide(show, setShow);
  const name = field.label.trim() || `field ${index + 1}`;
  return (
    <div className="flex items-center gap-2">
      <Input aria-label={`Custom field ${index + 1} label`} value={field.label} placeholder="Label" maxLength={MAX_CUSTOM_LABEL}
             className="!w-[34%] shrink-0" spellCheck={false}
             onChange={(e) => onChange({ ...field, label: e.target.value.slice(0, MAX_CUSTOM_LABEL) })} />
      <Input aria-label={`${name} value`} value={field.value} placeholder="Value" autoComplete="off" spellCheck={false}
             type={field.secret && !show ? "password" : "text"} className={`min-w-0 ${field.secret ? "font-mono" : ""}`}
             onChange={(e) => onChange({ ...field, value: e.target.value })} />
      <div className="shrink-0 flex items-center gap-1">
        <Tooltip content={field.secret ? "Secret: hidden until shown. Click to make it plain" : "Plain text. Click to make it secret"}>
          <Button size="sm" aria-label={field.secret ? `Make ${name} plain` : `Make ${name} secret`} aria-pressed={field.secret}
                  icon={field.secret ? <Lock size={13} /> : <LockOpen size={13} />}
                  onClick={() => { setShow(false); onChange({ ...field, secret: !field.secret }); }} />
        </Tooltip>
        {field.secret
          ? <RevealButton shown={show} onToggle={() => setShow((v) => !v)} name={name} />
          : <span className="w-[26px]" aria-hidden />}
        <CopyIconButton value={field.value} label={name} />
        <Tooltip content="Remove field">
          <Button size="sm" variant="danger" aria-label={`Remove ${name}`} icon={<X size={13} />} onClick={onRemove} />
        </Tooltip>
      </div>
    </div>
  );
}

/** "Custom fields" section: free label/value pairs, each optionally secret (masked, auto-hidden). */
export function CustomFieldsEditor({ value, onChange }: { value: CustomField[]; onChange: (next: CustomField[]) => void }) {
  const full = value.length >= MAX_CUSTOM_FIELDS;
  return (
    <Section
      title="Custom fields"
      aside={(
        <Button size="sm" icon={<Plus size={12} />} disabled={full}
                title={full ? `At most ${MAX_CUSTOM_FIELDS} custom fields` : undefined}
                onClick={() => onChange([...value, { label: "", value: "", secret: false }])}>
          Add field
        </Button>
      )}
    >
      {value.length === 0 ? (
        <p className="text-xs text-[var(--color-text-muted)]">
          Add anything else worth keeping with this entry: account numbers, security questions, licence keys…
        </p>
      ) : (
        value.map((f, i) => (
          // Keyed by position + count so a removed row never hands its "shown" state to the next one.
          <FieldRow key={`${i}-${value.length}`} field={f} index={i}
                    onChange={(nf) => onChange(value.map((x, j) => (j === i ? nf : x)))}
                    onRemove={() => onChange(value.filter((_, j) => j !== i))} />
        ))
      )}
    </Section>
  );
}
