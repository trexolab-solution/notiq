// Cut / Copy / Paste / Select all for a plain <input> or <textarea>, used by the
// window-level context menu so text boxes behave like native ones everywhere.
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import type { ContextMenuItem } from "../../components/ui/ContextMenu";
import { buildEditItems } from "./items";
import { TEXT_FIELD_SELECTOR } from "./target";

type Field = HTMLInputElement | HTMLTextAreaElement;

export function textFieldAt(t: EventTarget | null): Field | null {
  return t instanceof Element ? t.closest<Field>(TEXT_FIELD_SELECTOR) : null;
}

export interface TextFieldMenuOptions {
  /** False in windows without clipboard read permission: Paste is left out. */
  canPaste?: boolean;
}

export function buildTextFieldMenu(field: Field, opts: TextFieldMenuOptions = {}): ContextMenuItem[] {
  // `number` inputs expose no selection API (selectionStart is null).
  const start = field.selectionStart;
  const end   = field.selectionEnd;
  const hasSelection = start !== null && end !== null && start !== end;
  const readOnly = field.readOnly || field.disabled;

  // Act on the selection as it was at right-click time: the field's live selection
  // can collapse while the menu is open (seen with the tab rename box).
  const range = () => {
    const len = field.value.length;
    return [Math.min(start ?? len, len), Math.min(end ?? len, len)] as const;
  };

  // Write through the native setter so React's onChange fires and state updates.
  const replaceSelection = (text: string) => {
    const [s, e] = range();
    const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(field, field.value.slice(0, s) + text + field.value.slice(e));
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.focus();
    try { field.setSelectionRange(s + text.length, s + text.length); } catch { /* number inputs */ }
  };
  const selected = () => field.value.slice(...range());

  return buildEditItems(
    { hasSelection, readOnly, secret: field.type === "password", isEmpty: field.value.length === 0 },
    {
      cut: async () => { await writeText(selected()).catch(() => {}); replaceSelection(""); },
      copy: async () => { await writeText(selected()).catch(() => {}); field.focus(); },
      paste: opts.canPaste === false ? undefined : async () => {
        const clip = await readText().catch(() => "");
        if (clip) replaceSelection(clip); else field.focus();
      },
      selectAll: () => { field.focus(); field.select(); },
    },
  );
}
