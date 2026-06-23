import type * as monacoNs from "monaco-editor";
import { useAppStore } from "../../store";
import { aiImprove, aiFixGrammar, aiSummarize, aiCustomEdit } from "./actions";
import { attachTooltip } from "../domTooltip";

type Editor = monacoNs.editor.ICodeEditor;

// Minimal inline SVG icons (lucide paths) so the content-widget DOM stays self-contained.
const SVG = (inner: string) =>
  `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;

const ICON_IMPROVE = SVG('<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/>');
const ICON_GRAMMAR = SVG('<path d="m6 16 6-12 6 12"/><path d="M8 12h8"/><path d="m16 20 2 2 4-4"/>');
const ICON_SUMMARY = SVG('<line x1="8" x2="21" y1="6" y2="6"/><line x1="8" x2="21" y1="12" y2="12"/><line x1="8" x2="21" y1="18" y2="18"/><line x1="3" x2="3.01" y1="6" y2="6"/><line x1="3" x2="3.01" y1="12" y2="12"/><line x1="3" x2="3.01" y1="18" y2="18"/>');
const ICON_ASK = SVG('<path d="m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72Z"/><path d="m14 7 3 3"/>');
const ICON_BACK = SVG('<path d="m15 18-6-6 6-6"/>');
const ICON_SEND = SVG('<path d="M9 10 4 15l5 5"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/>');

interface Action { label: string; icon: string; run: (ed: Editor) => void; }

const ACTIONS: Action[] = [
  { label: "Improve",     icon: ICON_IMPROVE, run: (ed) => { void aiImprove(ed); } },
  { label: "Fix grammar", icon: ICON_GRAMMAR, run: (ed) => { void aiFixGrammar(ed); } },
  { label: "Summarize",   icon: ICON_SUMMARY, run: (ed) => { void aiSummarize(ed); } },
];

const MIN_SELECTION_CHARS = 2;

function iconButton(
  icon: string, label: string, withLabel: boolean, title: string,
  tooltips: Array<() => void>,
): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "ai-sel-toolbar__btn";
  btn.innerHTML = withLabel ? `${icon}<span>${label}</span>` : icon;
  tooltips.push(attachTooltip(btn, title));
  return btn;
}

/**
 * Floating AI quick-actions toolbar shown above a non-empty selection (only when
 * AI is enabled). Includes one-tap actions plus an "Ask AI" custom instruction
 * that edits ONLY the selected range. Returns a disposer.
 */
export function attachSelectionToolbar(editor: Editor, monaco: typeof monacoNs): () => void {
  const node = document.createElement("div");
  node.className = "ai-sel-toolbar";

  // Custom-tooltip disposers, cleaned up when the toolbar is detached.
  const tooltips: Array<() => void> = [];

  // ── Buttons pane ──────────────────────────────────────────────────────────
  const buttonsPane = document.createElement("div");
  buttonsPane.className = "ai-sel-toolbar__row";
  for (const a of ACTIONS) {
    const btn = iconButton(a.icon, a.label, true, a.label, tooltips);
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.addEventListener("click", (e) => { e.preventDefault(); a.run(editor); hide(); });
    buttonsPane.appendChild(btn);
  }
  const sep = document.createElement("span");
  sep.className = "ai-sel-toolbar__sep";
  buttonsPane.appendChild(sep);
  const askBtn = iconButton(ICON_ASK, "Ask AI", true, "Give a custom instruction for the selection", tooltips);
  askBtn.addEventListener("mousedown", (e) => e.preventDefault());
  askBtn.addEventListener("click", (e) => { e.preventDefault(); openInput(); });
  buttonsPane.appendChild(askBtn);

  // ── Input pane ────────────────────────────────────────────────────────────
  const inputPane = document.createElement("div");
  inputPane.className = "ai-sel-toolbar__row";
  inputPane.style.display = "none";
  const backBtn = iconButton(ICON_BACK, "Back", false, "Back", tooltips);

  // Replace ↔ Explain (append) mode toggle.
  let editMode: "replace" | "append" = "replace";
  const modeToggle = document.createElement("div");
  modeToggle.className = "ai-sel-toolbar__modes";
  const replaceBtn = document.createElement("button");
  replaceBtn.type = "button";
  replaceBtn.className = "ai-sel-toolbar__mode is-active";
  replaceBtn.textContent = "Replace";
  tooltips.push(attachTooltip(replaceBtn, "Replace the selected text with the AI result"));
  const appendBtn = document.createElement("button");
  appendBtn.type = "button";
  appendBtn.className = "ai-sel-toolbar__mode";
  appendBtn.textContent = "Explain";
  tooltips.push(attachTooltip(appendBtn, "Keep the selection and add the AI's answer below it"));
  modeToggle.append(replaceBtn, appendBtn);

  function setMode(m: "replace" | "append") {
    editMode = m;
    replaceBtn.classList.toggle("is-active", m === "replace");
    appendBtn.classList.toggle("is-active", m === "append");
  }
  replaceBtn.addEventListener("mousedown", (e) => e.preventDefault());
  replaceBtn.addEventListener("click", (e) => { e.preventDefault(); setMode("replace"); input.focus(); });
  appendBtn.addEventListener("mousedown", (e) => e.preventDefault());
  appendBtn.addEventListener("click", (e) => { e.preventDefault(); setMode("append"); input.focus(); });

  const input = document.createElement("input");
  input.type = "text";
  input.className = "ai-sel-toolbar__field";
  input.placeholder = "Tell AI what to do with the selection…";
  input.spellcheck = false;
  const sendBtn = iconButton(ICON_SEND, "Run", false, "Run (Enter)", tooltips);
  inputPane.append(backBtn, modeToggle, input, sendBtn);

  node.append(buttonsPane, inputPane);

  // ── State ─────────────────────────────────────────────────────────────────
  let visible = false;
  let position: monacoNs.IPosition | null = null;
  let showTimer: ReturnType<typeof setTimeout> | null = null;
  let editing = false;
  let pendingRange: monacoNs.IRange | null = null;

  const widget: monacoNs.editor.IContentWidget = {
    allowEditorOverflow: true,
    getId: () => "smart-note.ai-selection-toolbar",
    getDomNode: () => node,
    // Offer both placements: Monaco keeps the widget inside the viewport by
    // flipping ABOVE↔BELOW automatically (works for selections at the very
    // top/bottom edge too).
    getPosition: () =>
      visible && position
        ? {
            position,
            preference: [
              monaco.editor.ContentWidgetPositionPreference.ABOVE,
              monaco.editor.ContentWidgetPositionPreference.BELOW,
            ],
          }
        : null,
  };
  editor.addContentWidget(widget);

  function showButtonsPane() {
    editing = false;
    buttonsPane.style.display = "flex";
    inputPane.style.display = "none";
  }

  function openInput() {
    const sel = editor.getSelection();
    if (!sel || sel.isEmpty()) return;
    pendingRange = sel;
    editing = true;
    buttonsPane.style.display = "none";
    inputPane.style.display = "flex";
    input.value = "";
    setMode("replace");
    editor.layoutContentWidget(widget);
    setTimeout(() => input.focus(), 0);
  }

  function submit() {
    const instruction = input.value.trim();
    const range = pendingRange;
    if (!instruction || !range) return;
    const mode = editMode;
    hide();
    void aiCustomEdit(editor, range, instruction, mode);
  }

  backBtn.addEventListener("mousedown", (e) => e.preventDefault());
  backBtn.addEventListener("click", (e) => { e.preventDefault(); showButtonsPane(); editor.focus(); });
  sendBtn.addEventListener("mousedown", (e) => e.preventDefault());
  sendBtn.addEventListener("click", (e) => { e.preventDefault(); submit(); });
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); submit(); }
    else if (e.key === "Escape") { e.preventDefault(); hide(); editor.focus(); }
    else if (e.key === "Tab") { e.preventDefault(); }
  });
  // Clicking away (not onto the Back/Run buttons, which preventDefault) closes it.
  input.addEventListener("blur", () => { if (editing) hide(); });

  function show(pos: monacoNs.IPosition) {
    position = pos;
    visible = true;
    editor.layoutContentWidget(widget);
  }
  function hide() {
    if (showTimer) { clearTimeout(showTimer); showTimer = null; }
    showButtonsPane();
    pendingRange = null;
    if (!visible) return;
    visible = false;
    editor.layoutContentWidget(widget);
  }

  function update() {
    if (editing) return; // don't disturb an open instruction input
    if (!useAppStore.getState().aiEnabled) { hide(); return; }
    const sel = editor.getSelection();
    const model = editor.getModel();
    if (!sel || !model || sel.isEmpty()) { hide(); return; }
    if (model.getValueLengthInRange(sel) < MIN_SELECTION_CHARS) { hide(); return; }

    // Anchor to the ACTIVE end of the selection (where the caret is — what the
    // user is looking at), not the start. For a long top-down selection the start
    // may be scrolled off-screen, which would hide the toolbar.
    const pos = { lineNumber: sel.positionLineNumber, column: sel.positionColumn };
    if (showTimer) clearTimeout(showTimer);
    showTimer = setTimeout(() => show(pos), 180);
  }

  const subs = [
    editor.onDidChangeCursorSelection(() => update()),
    editor.onDidBlurEditorWidget(() => { if (!editing) hide(); }),
  ];
  const unsub = useAppStore.subscribe((st) => { if (!st.aiEnabled) hide(); });

  return () => {
    if (showTimer) clearTimeout(showTimer);
    subs.forEach((d) => d.dispose());
    unsub();
    tooltips.forEach((dispose) => dispose());
    editor.removeContentWidget(widget);
  };
}
