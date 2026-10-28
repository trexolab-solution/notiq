import { useMemo, useState } from "react";
import { Eye, EyeOff, KeyRound, Terminal } from "lucide-react";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { useAppStore } from "../../store";
import { CopyIconButton } from "./CopyIconButton";
import { parseSecret, serializeSecret, SECRET_KINDS, type FieldDef } from "../../lib/secretEntry";
import type { Tab } from "../../types";

const area = "w-full rounded-md px-2.5 py-2 text-sm bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] outline-none focus:border-[var(--color-primary)]";

function Field({ def, value, onChange }: { def: FieldDef; value: string; onChange: (v: string) => void }) {
  const [show, setShow] = useState(false);
  const secret = def.type === "secret" || def.type === "multiline-secret";
  const multi = def.type === "multiline" || def.type === "multiline-secret";
  const id = `se-${def.key}`;
  return (
    <div>
      <label className="block text-xs mb-1 text-[var(--color-text-muted)]" htmlFor={id}>{def.label}</label>
      <div className="flex items-start gap-2">
        {multi ? (
          <textarea id={id} rows={def.type === "multiline-secret" ? 6 : 4} value={value} placeholder={def.placeholder}
                    onChange={(e) => onChange(e.target.value)} spellCheck={false} autoComplete="off"
                    className={`${area} ${secret ? "font-mono" : ""}`}
                    style={secret && !show ? ({ WebkitTextSecurity: "disc" } as React.CSSProperties) : undefined} />
        ) : (
          <Input id={id} type={secret && !show ? "password" : "text"} value={value} placeholder={def.placeholder}
                 onChange={(e) => onChange(e.target.value)} spellCheck={false} autoComplete="off"
                 className={secret ? "font-mono" : ""} />
        )}
        {secret && (
          <Button size="sm" aria-label={show ? "Hide" : "Show"} icon={show ? <EyeOff size={12} /> : <Eye size={12} />}
                  onClick={() => setShow((v) => !v)} />
        )}
        {def.type !== "multiline" && (
          <CopyIconButton value={value} label={def.label.toLowerCase()} />
        )}
      </div>
    </div>
  );
}

/** Schema-driven editor for SSH / API-key vault entries. */
export function SecretEntryEditor({ tab, kind }: { tab: Tab; kind: string }) {
  const def = SECRET_KINDS[kind];
  const entry = useMemo(() => parseSecret(kind, tab.content), [kind, tab.content]);
  if (!def) return null;
  const save = (next: typeof entry) => useAppStore.getState().updateTabContent(tab.id, serializeSecret(next));
  const Icon = kind === "ssh" ? Terminal : KeyRound;

  return (
    <div data-tour="editor" className="flex-1 min-h-0 overflow-y-auto bg-[var(--color-editor-bg)]">
      <div className="max-w-xl mx-auto px-6 py-8 flex flex-col gap-4 text-[var(--color-text)]">
        <div className="flex items-center gap-2">
          <Icon size={18} style={{ color: "var(--color-primary)" }} />
          <h1 className="text-base font-semibold">{def.label}</h1>
        </div>
        <div>
          <label className="block text-xs mb-1 text-[var(--color-text-muted)]" htmlFor="se-title">Name</label>
          <Input id="se-title" value={entry.title} onChange={(e) => save({ ...entry, title: e.target.value })} />
        </div>
        {def.fields.map((f) => (
          <Field key={f.key} def={f} value={entry.fields[f.key] ?? ""}
                 onChange={(v) => save({ ...entry, fields: { ...entry.fields, [f.key]: v } })} />
        ))}
        <p className="text-xs text-[var(--color-text-muted)]">
          Saved with the vault when you save this tab (Ctrl+S). Copied values are cleared from the clipboard after 20 seconds.
        </p>
      </div>
    </div>
  );
}
