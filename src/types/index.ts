export type EditorMode = "markdown" | "preview" | "split";
export type TabKind    = "note" | "whiteboard";
export type AppView    = "editor" | "graph";

export type AutoClosingBrackets  = "always" | "beforeWhitespace" | "never";
export type RenderWhitespace     = "none" | "boundary" | "selection" | "trailing" | "all";
export type RenderLineHighlight  = "none" | "gutter" | "line" | "all";
export type EditorCursorStyle    = "line" | "block" | "underline" | "line-thin" | "block-outline" | "underline-thin";
export type EditorCursorBlinking = "blink" | "smooth" | "phase" | "expand" | "solid";
export type TerminalCursorStyle  = "block" | "underline" | "bar";
export type TerminalLayout       = "horizontal" | "vertical";

export type AIProvider    = "cloud" | "local";
export type AITriggerMode = "auto" | "manual";

export type ThemeId =
  | "dark" | "light"
  | "one-dark" | "nord" | "dracula"
  | "catppuccin" | "tokyo-night" | "rose-pine"
  | "gruvbox" | "solarized-dark" | "github-dark"
  | "monokai" | "kanagawa";

export interface TerminalAnsiColors {
  black: string; red: string; green: string; yellow: string;
  blue: string; magenta: string; cyan: string; white: string;
  brightBlack: string; brightRed: string; brightGreen: string; brightYellow: string;
  brightBlue: string; brightMagenta: string; brightCyan: string; brightWhite: string;
}

export interface Theme {
  id: ThemeId;
  label: string;
  colors: {
    bg: string;
    bgSecondary: string;
    bgTertiary: string;
    border: string;
    text: string;
    textMuted: string;
    primary: string;
    primaryHover: string;
    accent: string;
    success: string;
    warning: string;
    danger: string;
    editorBg: string;
    editorText: string;
  };
  ansi: TerminalAnsiColors;
}

export interface Tab {
  id: string;
  kind: TabKind;           // "note" (default) or "whiteboard"
  title: string;
  filePath?: string;
  content: string;
  isDirty: boolean;
  cursorPosition: { line: number; column: number };
  scrollPosition: number;
  editorMode: EditorMode;
  createdAt: number;
  updatedAt: number;
  linkedNoteId?: string;   // whiteboard tab → the note it is linked to
  isPinned: boolean;       // pinned tabs can't be closed and stick to the left
  /** Explicit Monaco language for unsaved tabs (e.g. AI-generated code snippets).
   *  When set, it overrides the language guessed from filePath. */
  language?: string;
  /** Pasted-image attachments. Key = relative path used in markdown (e.g. "assets/img-1.png");
   *  value = absolute fs path (temp folder for unsaved notes, <note-dir>/<rel> for saved). */
  attachments?: Record<string, string>;
}

export interface GraphNode {
  id: string;
  name: string;
  tabId?: string;
  val?: number;
}

export interface GraphLink {
  source: string;
  target: string;
}

export interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
}

export interface SessionData {
  tabs: Tab[];
  activeTabId: string | null;
  themeId: ThemeId;
  savedAt: number;
}
