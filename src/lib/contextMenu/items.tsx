// Pure builders for every right-click menu in the app. Each takes the state of the
// clicked target plus the actions that apply to it, and returns only the items that
// make sense there: an action the caller doesn't pass is left out, and one that
// can't run right now (no selection, read-only, …) is disabled.
import {
  AlignLeft, Clipboard, Copy, FilePlus, Files, FileText, FolderOpen, Heading, Link, Lock, LockOpen,
  PenLine, Pencil, Pin, PinOff, Replace, RotateCcw, RotateCw, Scissors, Search, SpellCheck,
  SquareMousePointer, SquarePen, Trash2, Workflow, X,
} from "lucide-react";
import type { ContextMenuItem } from "../../components/ui/ContextMenu";

type Action = () => void;

const SEPARATOR: ContextMenuItem = { type: "separator" };

/** Join non-empty groups with a single separator between them. */
export function joinGroups(...groups: ContextMenuItem[][]): ContextMenuItem[] {
  return groups
    .filter((g) => g.length > 0)
    .flatMap((g, i) => (i === 0 ? g : [SEPARATOR, ...g]));
}

function item(label: string, icon: JSX.Element, onClick: Action | undefined, extra: Partial<ContextMenuItem> = {}): ContextMenuItem[] {
  return onClick ? [{ type: "item", label, icon, onClick, ...extra }] : [];
}

// ── Cut / Copy / Paste ──────────────────────────────────────────────────────

export interface EditState {
  hasSelection: boolean;
  /** Read-only target: nothing that changes its text. */
  readOnly?: boolean;
  /** Password field: its text never goes to the clipboard. */
  secret?: boolean;
  /** No text at all: Select all has nothing to select. */
  isEmpty?: boolean;
}

export interface EditActions {
  cut?: Action;
  copy?: Action;
  /** Omit when the clipboard can't be read in this window. */
  paste?: Action;
  undo?: Action;
  redo?: Action;
  selectAll?: Action;
}

/** Clipboard / history / selection groups shared by every text surface. */
export function buildEditItems(s: EditState, a: EditActions): ContextMenuItem[] {
  const ro = !!s.readOnly;
  return joinGroups(
    [
      ...item("Cut",   <Scissors size={13} />,  a.cut,   { shortcut: "Ctrl+X", disabled: !s.hasSelection || ro || !!s.secret }),
      ...item("Copy",  <Copy size={13} />,      a.copy,  { shortcut: "Ctrl+C", disabled: !s.hasSelection || !!s.secret }),
      ...item("Paste", <Clipboard size={13} />, a.paste, { shortcut: "Ctrl+V", disabled: ro }),
    ],
    ro ? [] : [
      ...item("Undo", <RotateCcw size={13} />, a.undo, { shortcut: "Ctrl+Z" }),
      ...item("Redo", <RotateCw size={13} />,  a.redo, { shortcut: "Ctrl+Y" }),
    ],
    item("Select All", <SquareMousePointer size={13} />, a.selectAll, { shortcut: "Ctrl+A", disabled: !!s.isEmpty }),
  );
}

// ── Monaco editor ───────────────────────────────────────────────────────────

export interface EditorMenuState extends EditState {
  aiEnabled: boolean;
  /** Markdown / memory note: offer note-level AI actions. */
  isMarkdownNote: boolean;
  /** Caret sits inside a ```mermaid fence. */
  inMermaid: boolean;
}

export interface EditorMenuActions extends EditActions {
  find: Action;
  replace: Action;
  /** Omit when no formatter is registered for this editor. */
  format?: Action;
  aiContinue: Action;
  aiFixGrammar: Action;
  aiSummarize: Action;
  aiGenerateTitle: Action;
  aiFixMermaid: Action;
}

export function buildEditorMenu(s: EditorMenuState, a: EditorMenuActions): ContextMenuItem[] {
  const ro = !!s.readOnly;
  const ai: ContextMenuItem[] = [];
  // AI actions all write into the note, so a read-only editor gets none.
  if (s.aiEnabled && !ro) {
    ai.push(
      { type: "label", label: "AI" },
      ...item("Continue Writing", <PenLine size={13} />, a.aiContinue, { shortcut: "Alt+\\" }),
      ...item("Fix Grammar", <SpellCheck size={13} />, a.aiFixGrammar),
    );
    if (s.isMarkdownNote) {
      ai.push(
        ...item("Summarize Note", <FileText size={13} />, a.aiSummarize),
        ...item("Generate Title", <Heading size={13} />, a.aiGenerateTitle),
      );
    }
    if (s.inMermaid) ai.push(...item("Fix Mermaid", <Workflow size={13} />, a.aiFixMermaid));
  }
  return joinGroups(
    buildEditItems(s, a),
    [
      ...item("Find", <Search size={13} />, a.find, { shortcut: "Ctrl+F" }),
      ...(ro ? [] : item("Replace", <Replace size={13} />, a.replace, { shortcut: "Ctrl+H" })),
    ],
    ro ? [] : item("Format Document", <AlignLeft size={13} />, a.format, { shortcut: "Shift+Alt+F" }),
    ai,
  );
}

// ── Markdown preview ────────────────────────────────────────────────────────

export interface PreviewMenuState {
  hasSelection: boolean;
  /** href of the link under the cursor, if any. */
  linkHref?: string | null;
}

export function buildPreviewMenu(s: PreviewMenuState, a: { copy: Action; selectAll: Action; copyLink: Action }): ContextMenuItem[] {
  return joinGroups(
    s.linkHref ? item("Copy Link Address", <Link size={13} />, a.copyLink) : [],
    buildEditItems({ hasSelection: s.hasSelection, readOnly: true }, { copy: a.copy, selectAll: a.selectAll }),
  );
}

// ── Tab strip ───────────────────────────────────────────────────────────────

export interface TabMenuState {
  isPinned: boolean;
  canRename: boolean;
  /** A plain note that could be moved into the vault. */
  canLock: boolean;
  /** The tab shows a vault note. */
  isVault: boolean;
  vaultUnlocked: boolean;
}

export function buildTabMenu(
  s: TabMenuState,
  a: { togglePin: Action; rename: Action; lockToVault: Action; lockVault: Action; close: Action },
): ContextMenuItem[] {
  return joinGroups(
    [
      s.isPinned
        ? { type: "item", label: "Unpin Tab", icon: <PinOff size={13} />, onClick: a.togglePin }
        : { type: "item", label: "Pin Tab",   icon: <Pin size={13} />,    onClick: a.togglePin },
      ...(s.canRename ? item("Rename", <Pencil size={13} />, a.rename) : []),
    ],
    [
      ...(s.canLock ? item("Lock with Vault", <Lock size={13} />, a.lockToVault) : []),
      ...(s.isVault && s.vaultUnlocked ? item("Lock Vault Now", <Lock size={13} />, a.lockVault) : []),
    ],
    item("Close Tab", <X size={13} />, a.close, { shortcut: "Ctrl+W", danger: true, disabled: s.isPinned }),
  );
}

/** Empty space next to the tabs: ways to open a new one. */
export function buildTabStripMenu(a: { newNote: Action; newWhiteboard: Action; openFiles: Action; openFolder: Action }): ContextMenuItem[] {
  return joinGroups(
    [
      ...item("New Note", <FilePlus size={13} />, a.newNote, { shortcut: "Ctrl+N" }),
      ...item("New Whiteboard", <SquarePen size={13} />, a.newWhiteboard, { shortcut: "Ctrl+3" }),
    ],
    [
      ...item("Open File(s)", <Files size={13} />, a.openFiles, { shortcut: "Ctrl+O" }),
      ...item("Open Folder", <FolderOpen size={13} />, a.openFolder, { shortcut: "Ctrl+⇧+O" }),
    ],
  );
}

// ── Locked vault ────────────────────────────────────────────────────────────

export function buildVaultLockedMenu(vaultExists: boolean, unlock: Action): ContextMenuItem[] {
  return item(vaultExists ? "Unlock Vault" : "Create Vault", <LockOpen size={13} />, unlock);
}

// ── Terminal ────────────────────────────────────────────────────────────────

export function buildTerminalMenu(s: { hasSelection: boolean }, a: { copy: Action; paste: Action; selectAll: Action; clear: Action }): ContextMenuItem[] {
  return joinGroups(
    buildEditItems({ hasSelection: s.hasSelection }, { copy: a.copy, paste: a.paste, selectAll: a.selectAll }),
    item("Clear", <Trash2 size={13} />, a.clear),
  );
}
