import type {
  Tab, ThemeId, EditorMode, GraphData, AppView,
  AutoClosingBrackets, RenderWhitespace, RenderLineHighlight,
  EditorCursorStyle, EditorCursorBlinking, TerminalCursorStyle, TerminalLayout,
  AIProvider, AITriggerMode,
} from "../../types";
import type { FileEntry } from "../../lib/fileOps";
import type { VaultOpenMode } from "../../lib/vaultTabs";
import type { SettingsTarget } from "../../lib/tabKinds";
import type { SectionId } from "../../lib/settingsIndex";

// ─── store shape ────────────────────────────────────────────────────────────
export interface AppState {
  // tabs
  tabs: Tab[];
  activeTabId: string | null;
  addTab: (overrides?: Partial<Tab>) => void;
  removeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  updateTabContent: (id: string, content: string) => void;
  updateTabTitle: (id: string, title: string) => void;
  updateTabCursor: (id: string, line: number, column: number) => void;
  updateTabScroll: (id: string, scroll: number) => void;
  updateTabEditorMode: (id: string, mode: EditorMode) => void;
  markTabClean: (id: string) => void;
  /** Record a paste-image attachment on a tab (relativePath → absolute fs path). */
  addAttachment: (id: string, relativePath: string, absolutePath: string) => void;

  togglePinTab: (id: string) => void;
  reorderTabs: (tabs: Tab[]) => void;

  // settings tab
  /**
   * Open the singleton Settings tab (activate it if it exists, else create it) and switch to the editor
   * view. With a `section` (and optionally a `settingId` from a SETTINGS_INDEX), records a new
   * `settingsTarget` the page consumes to scroll to and reveal that place.
   */
  openSettings: (section?: SectionId, settingId?: string) => void;
  /** Opens (or focuses) the remote file manager tab for a saved server. */
  openRemoteFiles: (target: { path: string; auth: "key" | "password"; title: string }) => void;
  /** Latest deep-link request for the Settings page (null = none yet). */
  settingsTarget: SettingsTarget | null;

  // file I/O
  saveTabToFile: (id: string) => Promise<boolean>;
  saveTabToFileAs: (id: string) => Promise<boolean>;
  /** Open an already-read list of files as tabs (skips duplicates by filePath). */
  openFilesAsTabs: (files: FileEntry[]) => void;
  /**
   * Open a vault entry from the sidebar. "preview" reuses the clean preview tab (or makes one);
   * "permanent" gets its own tab. An entry that's already open is just focused.
   */
  openVaultEntry: (file: FileEntry, mode: VaultOpenMode) => void;
  /** Turn a preview tab into a normal (permanent) one. */
  makeTabPermanent: (id: string) => void;
  /** Replace a tab's content with fresh disk content (external change) — keeps it clean. */
  reloadTabFromDisk: (id: string, content: string) => void;

  // secure vault
  /** Encrypts a tab into a `.nqv` file. `plainPath` is the original unencrypted file, if any. */
  lockTabToVault: (id: string) => Promise<{ ok: boolean; plainPath?: string }>;
  /** Decrypts every locked `.nqv` tab (vault must be unlocked). */
  unlockVaultTabs: () => Promise<void>;
  /** Re-reads open, unlocked, clean vault tabs from disk (after a sync pulled changes). */
  refreshVaultTabs: () => Promise<void>;
  /** Saves dirty vault tabs, drops the key from memory, blanks vault tabs. */
  lockVault: () => Promise<boolean>;
  /** A vault entry (note or folder) was renamed/moved: re-point open tabs at/under `from` to `to`. */
  remapVaultTabs: (from: string, to: string) => void;
  /** A vault entry was trashed: close its open tabs (at/under `path`) without a save prompt. */
  closeVaultTabs: (path: string) => void;

  // theme
  themeId: ThemeId;
  setTheme: (id: ThemeId) => void;

  // preferences
  editorFontSize: number;
  setEditorFontSize: (size: number) => void;
  wordWrap: boolean;
  setWordWrap: (v: boolean) => void;
  showLineNumbers: boolean;
  setShowLineNumbers: (v: boolean) => void;
  defaultEditorMode: EditorMode;
  setDefaultEditorMode: (mode: EditorMode) => void;

  fontFamily: string;
  setFontFamily: (v: string) => void;
  tabSize: number;
  setTabSize: (v: number) => void;
  minimap: boolean;
  setMinimap: (v: boolean) => void;
  bracketPairColorization: boolean;
  setBracketPairColorization: (v: boolean) => void;
  formatOnPaste: boolean;
  setFormatOnPaste: (v: boolean) => void;
  autoClosingBrackets: AutoClosingBrackets;
  setAutoClosingBrackets: (v: AutoClosingBrackets) => void;
  renderWhitespace: RenderWhitespace;
  setRenderWhitespace: (v: RenderWhitespace) => void;
  smoothScrolling: boolean;
  setSmoothScrolling: (v: boolean) => void;
  mouseWheelScrollSensitivity: number;
  setMouseWheelScrollSensitivity: (v: number) => void;
  scrollBeyondLastLine: boolean;
  setScrollBeyondLastLine: (v: boolean) => void;
  folding: boolean;
  setFolding: (v: boolean) => void;
  renderLineHighlight: RenderLineHighlight;
  setRenderLineHighlight: (v: RenderLineHighlight) => void;
  letterSpacing: number;
  setLetterSpacing: (v: number) => void;
  cursorStyle: EditorCursorStyle;
  setCursorStyle: (v: EditorCursorStyle) => void;
  cursorBlinking: EditorCursorBlinking;
  setCursorBlinking: (v: EditorCursorBlinking) => void;
  terminalFontSize: number;
  setTerminalFontSize: (v: number) => void;
  terminalCursorStyle: TerminalCursorStyle;
  setTerminalCursorStyle: (v: TerminalCursorStyle) => void;
  terminalCursorBlink: boolean;
  setTerminalCursorBlink: (v: boolean) => void;
  terminalScrollback: number;
  setTerminalScrollback: (v: number) => void;
  terminalLayout: TerminalLayout;
  setTerminalLayout: (v: TerminalLayout) => void;

  // AI / Autocomplete (the API key is not here — it's in a Rust-managed config file)
  aiEnabled: boolean;
  setAiEnabled: (v: boolean) => void;
  aiProvider: AIProvider;
  setAiProvider: (v: AIProvider) => void;
  aiModel: string;
  setAiModel: (v: string) => void;
  aiModelCloud: string;
  setAiModelCloud: (v: string) => void;
  aiModelLocal: string;
  setAiModelLocal: (v: string) => void;
  aiModelOpenrouter: string;
  setAiModelOpenrouter: (v: string) => void;
  aiFallbackProvider: AIProvider | "none";
  setAiFallbackProvider: (v: AIProvider | "none") => void;
  aiFallbackModel: string;
  setAiFallbackModel: (v: string) => void;
  aiAutocompleteEnabled: boolean;
  setAiAutocompleteEnabled: (v: boolean) => void;
  aiTriggerMode: AITriggerMode;
  setAiTriggerMode: (v: AITriggerMode) => void;
  aiDebounceMs: number;
  setAiDebounceMs: (v: number) => void;
  aiContextLines: number;
  setAiContextLines: (v: number) => void;
  aiOnboarded: boolean;
  setAiOnboarded: (v: boolean) => void;

  // Updates
  autoUpdateCheck: boolean;
  setAutoUpdateCheck: (v: boolean) => void;

  /** Reset every editor + terminal preference back to its default value. */
  resetPreferences: () => void;

  // graph
  graphData: GraphData;
  rebuildGraph: () => void;

  // view
  activeView: AppView;
  setActiveView: (view: AppView) => void;
  /** Text to find and reveal in the editor when jumping here (from the graph or
   *  global search). `line` (1-based) disambiguates when the text occurs more
   *  than once — the editor reveals the match on that line instead of the first. */
  pendingJump: { tabId: string; searchText: string; line?: number } | null;
  clearPendingJump: () => void;
  /** Switch to editor, activate tab, force split mode, all in one commit. */
  navigateToNote: (tabId: string, searchText?: string, line?: number) => void;

  // session
  sessionReady: boolean;
  hydrate: (tabs: Tab[], activeTabId: string | null, themeId: ThemeId) => void;
}
