import { useId, useState } from "react";
import { ExternalLink, Globe, X } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import {
  AddRowButton, listBoxClass, listRowHoverClass, reinsert, RowActions, RowIconButton, useAnnouncer, useFieldError, useLatest, useListFocus, useUndoToast,
} from "./ListEditor";
import { extraUrlError, hostOf, MAX_LOGIN_URLS, type LoginEntry } from "../../lib/loginEntry";

/**
 * "Other websites" under a login's main website: the extra sites the same login works on (`entry.urls`).
 * Rows can be opened or removed (with Undo); new sites go through an inline, validated add box.
 */
export function LoginSitesEditor({ entry, onChange }: { entry: LoginEntry; onChange: (urls: string[]) => void }) {
  const [draft, setDraft] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const headingId = useId();
  const { rootRef, focusAfter } = useListFocus();
  const { announce, region } = useAnnouncer();
  const undo = useUndoToast();
  const field = useFieldError(err);
  const urls = entry.urls ?? [];
  const latest = useLatest({ urls, onChange });
  const full = urls.length >= MAX_LOGIN_URLS;
  const limitText = `Up to ${MAX_LOGIN_URLS} other websites`;

  const close = () => { setAdding(false); setDraft(""); setErr(null); focusAfter("add"); };

  const add = () => {
    const why = extraUrlError(draft, entry);
    if (why) { setErr(why); return; }
    const site = draft.trim();
    onChange([...urls, site]);
    setDraft(""); setErr(null);
    announce(`Added ${site}`);
    // Stay in the box for the next one, unless that was the last slot.
    if (urls.length + 1 >= MAX_LOGIN_URLS) { setAdding(false); focusAfter("add"); }
  };

  const remove = (i: number) => {
    const site = urls[i];
    onChange(urls.filter((_, j) => j !== i));
    focusAfter(urls.length > 1 ? { index: i } : "add");
    announce(`Removed ${site}`);
    undo(`Removed ${site}`, () => {
      const l = latest.current;
      if (l.urls.includes(site) || l.urls.length >= MAX_LOGIN_URLS) return;
      l.onChange(reinsert(l.urls, i, site));
      announce(`Restored ${site}`);
    });
  };

  return (
    <div ref={rootRef} className="mt-2 flex flex-col gap-1.5">
      {region}
      {urls.length > 0 && (
        <>
          <span className="text-xs text-[var(--color-text-muted)]" id={headingId}>Also used on</span>
          <ul aria-labelledby={headingId} className={listBoxClass}>
            {urls.map((u, i) => {
              const host = hostOf(u);
              return (
                <li key={`${u}-${i}`} data-list-row
                    className={`flex items-center gap-2 pl-2.5 pr-1 py-0.5 text-[13px] ${listRowHoverClass}`}>
                  <Globe size={13} className="shrink-0 text-[var(--color-text-muted)]" aria-hidden />
                  <span className="flex-1 min-w-0 truncate" title={u}>{u}</span>
                  <RowActions>
                    {host && (
                      <RowIconButton data-row-focus label={`Open ${host}`} icon={<ExternalLink size={13} />}
                                     onClick={() => { void openUrl(`https://${host}`); }} />
                    )}
                    <RowIconButton danger data-row-focus={host ? undefined : ""} label={`Remove website ${u}`}
                                   tooltip="Remove website" icon={<X size={13} />} onClick={() => remove(i)} />
                  </RowActions>
                </li>
              );
            })}
          </ul>
        </>
      )}
      {adding ? (
        <div>
          <div className="flex items-center gap-1.5">
            <Input aria-label="New website for this login" value={draft} autoFocus spellCheck={false}
                   placeholder="e.g. https://login.example.co.uk" {...field.inputProps} className={field.errorClass}
                   onChange={(e) => { setDraft(e.target.value); setErr(null); }}
                   onKeyDown={(e) => {
                     if (e.key === "Enter") { e.preventDefault(); add(); }
                     else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
                   }} />
            <Button size="sm" variant="primary" className="min-h-7" onClick={add}>Add</Button>
            <Button size="sm" className="min-h-7" onClick={close}>Cancel</Button>
          </div>
          {field.message}
        </div>
      ) : (
        <div>
          <AddRowButton block atLimit={full} limitText={limitText} tooltip="Use this login on another website too"
                        onAdd={() => setAdding(true)}>
            Add website
          </AddRowButton>
        </div>
      )}
    </div>
  );
}
