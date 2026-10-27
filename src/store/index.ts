import { create } from "zustand";
import { v4 as uuidv4 } from "uuid";
import type {
  Tab, TabKind, ThemeId, EditorMode, GraphData, AppView,
  AutoClosingBrackets, RenderWhitespace, RenderLineHighlight,
  EditorCursorStyle, EditorCursorBlinking, TerminalCursorStyle, TerminalLayout,
  AIProvider, AITriggerMode,
} from "../types";
import { applyTheme } from "../lib/themes";
import { saveSession } from "../lib/session";
import { buildGraphData } from "../lib/graph";
import { pickSavePath, writeFile, type FileEntry } from "../lib/fileOps";
import { isVaultPath, extFromPath, vaultLock, vaultReadFile, vaultWriteFile, vaultErrorMessage, vaultFileExists } from "../lib/vault";
import { useVaultStore } from "./vaultStore";
import { pickVaultDestination } from "../lib/vaultDest";
import { syncBeforeLock } from "../lib/telegram";
import { scrubMonacoModels } from "../lib/vaultMemory";
import { ensureVaultDir } from "../lib/vaultDir";
import { getFileName } from "../lib/pathUtils";
import { migrateTempToSaveDir, cleanupTabTemp } from "../lib/attachments";
import { toast } from "../lib/toast";
import { emit } from "@tauri-apps/api/event";
import { buildPreferenceSlice, resetAllPreferences } from "./preferences";

// ─── debounced helpers ───────────────────────────────────────────────────────

let _contentPersistTimer: ReturnType<typeof setTimeout> | null = null;
let _pendingPersistFn: (() => void) | null = null;

function debounceContentPersist(fn: () => void) {
  _pendingPersistFn = fn;
  if (_contentPersistTimer) clearTimeout(_contentPersistTimer);
  _contentPersistTimer = setTimeout(() => { _pendingPersistFn = null; fn(); }, 300);
}

/** Flush any pending debounced persist immediately — called on window close. */
export function flushPendingPersist() {
  if (_pendingPersistFn) {
    if (_contentPersistTimer) clearTimeout(_contentPersistTimer);
    _pendingPersistFn();
    _pendingPersistFn = null;
    _contentPersistTimer = null;
  }
}

let _graphRebuildTimer: ReturnType<typeof setTimeout> | null = null;

function debounceGraphRebuild(fn: () => void) {
  if (_graphRebuildTimer) clearTimeout(_graphRebuildTimer);
  _graphRebuildTimer = setTimeout(fn, 400);
}

/** Flush any pending debounced graph rebuild immediately — called on window close. */
export function flushPendingGraphRebuild() {
  if (_graphRebuildTimer) {
    clearTimeout(_graphRebuildTimer);
    _graphRebuildTimer = null;
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

function titleFromPath(path: string, fallback: string): string {
  const fileName = getFileName(path) || fallback;
  return fileName.replace(/\.(md|markdown|txt|nqv)$/i, "");
}

function makeTab(overrides: Partial<Tab> = {}): Tab {
  return {
    id: uuidv4(),
    kind: "note",
    title: "Untitled",
    content: "",
    isDirty: false,
    cursorPosition: { line: 1, column: 1 },
    scrollPosition: 0,
    editorMode: "split",
    isPinned: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

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

  // file I/O
  saveTabToFile: (id: string) => Promise<boolean>;
  saveTabToFileAs: (id: string) => Promise<boolean>;
  /** Open an already-read list of files as tabs (skips duplicates by filePath). */
  openFilesAsTabs: (files: FileEntry[]) => void;
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
  /** `skipSync`: lock instantly (panic) without the pre-lock Telegram backup. */
  lockVault: (opts?: { skipSync?: boolean }) => Promise<boolean>;

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

// ─── store ──────────────────────────────────────────────────────────────────

export const useAppStore = create<AppState>((set, get) => {
  const persist = () => {
    const { tabs, activeTabId, themeId } = get();
    // Secure Vault: decrypted content must never reach IndexedDB. Persist vault
    // tabs as locked shells; they re-open locked and decrypt from the .nqv file.
    const safeTabs = tabs.map((t) =>
      isVaultPath(t.filePath) ? { ...t, content: "", isDirty: false, vaultLocked: true } : t,
    );
    saveSession({ tabs: safeTabs, activeTabId, themeId, savedAt: Date.now() });
  };

  /** Update a single tab by id, merging `changes` into the matched tab. */
  const updateTab = (id: string, changes: Partial<Tab>) => {
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...changes } : t)),
    }));
  };

  /** Shared save implementation — `forcePickPath` forces a Save-As dialog. */
  const saveTabImpl = async (id: string, forcePickPath: boolean): Promise<boolean> => {
    const tab = get().tabs.find((t) => t.id === id);
    if (!tab) return false;
    // A locked vault tab has empty content — saving it would wipe the note.
    if (tab.vaultLocked) return false;
    const path = forcePickPath
      ? await pickSavePath(tab.title)
      : (tab.filePath ?? await pickSavePath(tab.title));
    if (!path) return false;

    // Migrate any temp attachments to <note-dir>/<rel> BEFORE writing the markdown.
    // If migration fails, abort: the .md must not reference files that aren't there.
    let migratedAttachments = tab.attachments;
    if (tab.attachments && Object.keys(tab.attachments).length > 0) {
      try {
        migratedAttachments = await migrateTempToSaveDir(tab, path);
      } catch (e) {
        console.error("save: attachment migration failed", e);
        toast.error("Couldn't save attachments — note not saved");
        return false;
      }
    }

    let vaultExt = tab.vaultExt;
    if (isVaultPath(path)) {
      if (!(await useVaultStore.getState().ensureUnlocked())) return false;
      vaultExt = vaultExt ?? "md";
      try {
        await vaultWriteFile(path, tab.content, vaultExt);
      } catch (e) {
        toast.error(`Couldn't save locked note: ${vaultErrorMessage(e)}`);
        return false;
      }
    } else {
      await writeFile(path, tab.content);
      vaultExt = undefined;
    }
    updateTab(id, {
      filePath: path,
      vaultExt,
      title: titleFromPath(path, tab.title),
      isDirty: false,
      updatedAt: Date.now(),
      attachments: migratedAttachments,
    });
    get().rebuildGraph();
    persist();
    return true;
  };

  return {
    // ── tabs ──────────────────────────────────────────────────
    tabs: [],
    activeTabId: null,

    addTab(overrides = {}) {
      const { defaultEditorMode } = get();
      const tab = makeTab({ editorMode: defaultEditorMode, ...overrides });
      set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id, sessionReady: true }));
      debounceGraphRebuild(() => get().rebuildGraph());
      persist();
    },

    removeTab(id) {
      const target = get().tabs.find((t) => t.id === id);
      if (!target) return;
      // Pinned tabs cannot be closed — unpin first
      if (target.isPinned) return;
      // Clean up whiteboard-specific localStorage when a whiteboard tab is closed
      if (target.kind === "whiteboard") {
        try { localStorage.removeItem(`smart-note:wb-${id}`); } catch { /* ignore */ }
      }
      // Vault note: drop its decrypted text from the editor-model cache.
      if (isVaultPath(target.filePath)) setTimeout(() => void scrubMonacoModels([id]), 100);
      // Clean up temp attachment folder if this tab had unsaved pasted images
      if (target.attachments && Object.keys(target.attachments).length > 0) {
        cleanupTabTemp(id).catch((e) => console.warn("removeTab: temp cleanup failed", e));
      }
      set((s) => {
        const tabs = s.tabs.filter((t) => t.id !== id);
        let activeTabId = s.activeTabId;
        if (activeTabId === id) {
          const idx = s.tabs.findIndex((t) => t.id === id);
          activeTabId = tabs[Math.max(0, idx - 1)]?.id ?? null;
        }
        return { tabs, activeTabId };
      });
      debounceGraphRebuild(() => get().rebuildGraph());
      persist();
    },

    setActiveTab(id) {
      set({ activeTabId: id });
      persist();
    },

    updateTabContent(id, content) {
      const tab = get().tabs.find((t) => t.id === id);
      const changes: Partial<Tab> = { content, isDirty: true, updatedAt: Date.now() };

      // Auto-derive title from first line for unsaved tabs (like Windows 11 Notepad)
      if (tab && !tab.filePath && tab.kind === "note") {
        const firstLine = content.split("\n")[0]?.trim() ?? "";
        // Strip markdown heading markers (# / ## / ### …)
        const clean = firstLine.replace(/^#+\s*/, "").trim();
        changes.title = clean.slice(0, 60) || "Untitled";
      }

      updateTab(id, changes);
      debounceContentPersist(persist);
      debounceGraphRebuild(() => get().rebuildGraph());
    },

    updateTabTitle(id, title) {
      updateTab(id, { title, updatedAt: Date.now() });
      debounceGraphRebuild(() => get().rebuildGraph());
      persist();
    },

    updateTabCursor(id, line, column) {
      updateTab(id, { cursorPosition: { line, column } });
    },

    updateTabScroll(id, scrollPosition) {
      updateTab(id, { scrollPosition });
      // Persist (debounced) so the scroll ratio survives an app restart.
      debounceContentPersist(persist);
    },

    updateTabEditorMode(id, mode) {
      updateTab(id, { editorMode: mode });
      persist();
    },

    markTabClean(id) {
      updateTab(id, { isDirty: false });
    },

    addAttachment(id, relativePath, absolutePath) {
      const tab = get().tabs.find((t) => t.id === id);
      if (!tab) return;
      const next = { ...(tab.attachments ?? {}), [relativePath]: absolutePath };
      updateTab(id, { attachments: next, updatedAt: Date.now() });
      persist();
    },

    togglePinTab(id) {
      set((s) => {
        const toggled = s.tabs.map((t) =>
          t.id === id ? { ...t, isPinned: !t.isPinned } : t
        );
        // Re-sort: pinned tabs first (preserve relative order within each group)
        const pinned = toggled.filter((t) => t.isPinned);
        const unpinned = toggled.filter((t) => !t.isPinned);
        return { tabs: [...pinned, ...unpinned] };
      });
      persist();
    },

    reorderTabs(tabs) {
      set({ tabs });
      persist();
    },

    // ── file I/O ──────────────────────────────────────────────
    saveTabToFile: (id) => saveTabImpl(id, false),
    saveTabToFileAs: (id) => saveTabImpl(id, true),

    openFilesAsTabs(files) {
      if (files.length === 0) return;
      const { defaultEditorMode, tabs } = get();

      // Map normalized path → existing tab id so a file that's already open is
      // re-focused instead of opened twice. Paths arrive from several sources
      // (file dialog, drag-drop, OS file-association, second-instance) with
      // mixed separators and casing, so compare on a canonical key.
      const norm = (p?: string) => (p ? p.replace(/\\/g, "/").toLowerCase() : "");
      const byPath = new Map<string, string>();
      for (const t of tabs) {
        if (t.filePath) byPath.set(norm(t.filePath), t.id);
      }

      const newTabs: Tab[] = [];
      let focusId: string | null = null;
      for (const { path, content, title } of files) {
        const filePath = path.replace(/\\/g, "/");
        const key = norm(filePath);
        const existingId = byPath.get(key);
        if (existingId) {
          // Already open (or a duplicate within this same batch) — just focus it.
          focusId = existingId;
          continue;
        }
        const tab = isVaultPath(filePath)
          // Ciphertext is never read into a tab; it opens locked and decrypts on unlock.
          ? makeTab({ title, content: "", filePath, isDirty: false, editorMode: defaultEditorMode, vaultLocked: true })
          : makeTab({ title, content, filePath, isDirty: false, editorMode: defaultEditorMode });
        newTabs.push(tab);
        byPath.set(key, tab.id);
        focusId = tab.id;
      }

      if (newTabs.length === 0) {
        // Every requested file is already open — restore focus to the last one.
        if (focusId && focusId !== get().activeTabId) {
          set({ activeTabId: focusId });
          persist();
        }
        return;
      }

      set((s) => ({
        tabs:        [...s.tabs, ...newTabs],
        activeTabId: focusId ?? newTabs[newTabs.length - 1].id,
      }));
      debounceGraphRebuild(() => get().rebuildGraph());
      persist();
      // Vault already unlocked this session → decrypt the newly opened tabs now.
      if (newTabs.some((t) => t.vaultLocked) && useVaultStore.getState().unlocked) {
        void get().unlockVaultTabs();
      }
    },

    reloadTabFromDisk(id, content) {
      const tab = get().tabs.find((t) => t.id === id);
      if (!tab || tab.content === content) return;
      // External edit picked up by the file watcher — adopt disk content and
      // keep the tab clean (it now matches what's on disk, like Notepad++).
      updateTab(id, { content, isDirty: false, updatedAt: Date.now() });
      debounceGraphRebuild(() => get().rebuildGraph());
      persist();
    },

    // ── secure vault ──────────────────────────────────────────
    async lockTabToVault(id) {
      const tab = get().tabs.find((t) => t.id === id);
      if (!tab || tab.kind !== "note") return { ok: false };
      if (isVaultPath(tab.filePath)) return { ok: true };

      if (!(await useVaultStore.getState().ensureUnlocked())) return { ok: false };

      const plainPath = tab.filePath;
      // Offer a folder inside the vault storage folder (SSH, Logins, …).
      const target = await pickVaultDestination(tab.title);
      if (!target) return { ok: false };

      try {
        if (plainPath && (await vaultFileExists(target, await ensureVaultDir()))) {
          toast.error(`"${target.split(/[\\/]/).pop()}" already exists — rename or remove it first`);
          return { ok: false };
        }
        const ext = extFromPath(plainPath);
        await vaultWriteFile(target, tab.content, ext);
        updateTab(id, {
          filePath: target.replace(/\\/g, "/"),
          title: titleFromPath(target, tab.title),
          vaultExt: ext,
          vaultLocked: false,
          isDirty: false,
          updatedAt: Date.now(),
        });
      } catch (e) {
        toast.error(`Couldn't lock note: ${vaultErrorMessage(e)}`);
        return { ok: false };
      }
      get().rebuildGraph();
      persist();
      return { ok: true, plainPath };
    },

    async unlockVaultTabs() {
      const targets = get().tabs.filter((t) => isVaultPath(t.filePath) && t.vaultLocked);
      for (const t of targets) {
        try {
          const file = await vaultReadFile(t.filePath!);
          // The tab may have been closed while we were decrypting.
          if (!get().tabs.some((x) => x.id === t.id)) continue;
          updateTab(t.id, {
            content: file.content,
            vaultExt: file.ext || "md",
            vaultLocked: false,
            isDirty: false,
          });
        } catch (e) {
          toast.error(`Couldn't open "${t.title}": ${vaultErrorMessage(e)}`);
        }
      }
      debounceGraphRebuild(() => get().rebuildGraph());
      persist();
    },

    async refreshVaultTabs() {
      const targets = get().tabs.filter((t) => isVaultPath(t.filePath) && !t.vaultLocked && !t.isDirty);
      for (const t of targets) {
        try {
          const file = await vaultReadFile(t.filePath!);
          const cur = get().tabs.find((x) => x.id === t.id);
          if (!cur || cur.isDirty || cur.vaultLocked || cur.content === file.content) continue;
          updateTab(t.id, { content: file.content, vaultExt: file.ext || "md", isDirty: false });
        } catch { /* file may not exist (yet) */ }
      }
    },

    async lockVault(opts) {
      // Never lose edits: save dirty vault tabs first; abort the lock if any fails.
      const dirty = get().tabs.filter((t) => isVaultPath(t.filePath) && !t.vaultLocked && t.isDirty);
      for (const t of dirty) {
        if (!(await saveTabImpl(t.id, false))) {
          toast.error(`Couldn't save "${t.title}" — vault not locked`);
          return false;
        }
      }
      if (!opts?.skipSync) await syncBeforeLock();
      try {
        await vaultLock();
      } catch (e) {
        toast.error(`Couldn't lock vault: ${vaultErrorMessage(e)}`);
        return false;
      }
      useVaultStore.getState().setUnlocked(false);
      const vaultTabIds = get().tabs.filter((t) => isVaultPath(t.filePath)).map((t) => t.id);
      set((s) => ({
        tabs: s.tabs.map((t) =>
          isVaultPath(t.filePath) ? { ...t, content: "", isDirty: false, vaultLocked: true } : t,
        ),
      }));
      get().rebuildGraph();
      persist();
      // After React has swapped the editor for the lock screen, purge cached plaintext.
      setTimeout(() => void scrubMonacoModels(vaultTabIds), 100);
      return true;
    },

    // ── theme ─────────────────────────────────────────────────
    themeId: "dark",

    setTheme(id) {
      applyTheme(id);
      localStorage.setItem("pref:theme", id);
      set({ themeId: id });
      persist();
      emit("theme-changed", { themeId: id }).catch((e) => console.warn("theme broadcast failed", e));
    },

    // ── preferences (generated from declarative registry) ─────
    ...(buildPreferenceSlice(
      set as (partial: Record<string, unknown>) => void,
      get as unknown as () => Record<string, unknown>,
    ) as Pick<
      AppState,
      | "editorFontSize" | "setEditorFontSize"
      | "wordWrap" | "setWordWrap"
      | "showLineNumbers" | "setShowLineNumbers"
      | "defaultEditorMode" | "setDefaultEditorMode"
      | "fontFamily" | "setFontFamily"
      | "tabSize" | "setTabSize"
      | "minimap" | "setMinimap"
      | "bracketPairColorization" | "setBracketPairColorization"
      | "formatOnPaste" | "setFormatOnPaste"
      | "autoClosingBrackets" | "setAutoClosingBrackets"
      | "renderWhitespace" | "setRenderWhitespace"
      | "smoothScrolling" | "setSmoothScrolling"
      | "mouseWheelScrollSensitivity" | "setMouseWheelScrollSensitivity"
      | "scrollBeyondLastLine" | "setScrollBeyondLastLine"
      | "folding" | "setFolding"
      | "renderLineHighlight" | "setRenderLineHighlight"
      | "letterSpacing" | "setLetterSpacing"
      | "cursorStyle" | "setCursorStyle"
      | "cursorBlinking" | "setCursorBlinking"
      | "terminalFontSize" | "setTerminalFontSize"
      | "terminalCursorStyle" | "setTerminalCursorStyle"
      | "terminalCursorBlink" | "setTerminalCursorBlink"
      | "terminalScrollback" | "setTerminalScrollback"
      | "terminalLayout" | "setTerminalLayout"
      | "aiEnabled" | "setAiEnabled"
      | "aiProvider" | "setAiProvider"
      | "aiModel" | "setAiModel"
      | "aiModelCloud" | "setAiModelCloud"
      | "aiModelLocal" | "setAiModelLocal"
      | "aiModelOpenrouter" | "setAiModelOpenrouter"
      | "aiFallbackProvider" | "setAiFallbackProvider"
      | "aiFallbackModel" | "setAiFallbackModel"
      | "aiAutocompleteEnabled" | "setAiAutocompleteEnabled"
      | "aiTriggerMode" | "setAiTriggerMode"
      | "aiDebounceMs" | "setAiDebounceMs"
      | "aiContextLines" | "setAiContextLines"
      | "aiOnboarded" | "setAiOnboarded"
      | "autoUpdateCheck" | "setAutoUpdateCheck"
    >),

    resetPreferences() {
      resetAllPreferences(set as (partial: Record<string, unknown>) => void);
    },

    // ── graph ─────────────────────────────────────────────────
    graphData: { nodes: [], links: [] },

    rebuildGraph() {
      const { tabs } = get();
      set({ graphData: buildGraphData(tabs) });
    },

    // ── view ──────────────────────────────────────────────────
    activeView: "editor",

    setActiveView(view) {
      set({ activeView: view });
    },

    pendingJump: null,
    clearPendingJump() { set({ pendingJump: null }); },

    navigateToNote(tabId, searchText, line) {
      set((s) => ({
        activeView:  "editor",
        activeTabId: tabId,
        pendingJump: searchText ? { tabId, searchText, line } : null,
        tabs: s.tabs.map((t) =>
          t.id === tabId && t.editorMode !== "split"
            ? { ...t, editorMode: "split" as EditorMode }
            : t
        ),
      }));
      persist();
    },

    // ── session hydration ─────────────────────────────────────
    sessionReady: false,

    hydrate(tabs, activeTabId, themeId) {
      applyTheme(themeId);
      localStorage.setItem("pref:theme", themeId);
      const migratedTabs = tabs.map((t) => ({
        ...t,
        kind: (t.kind ?? "note") as TabKind,
        editorMode: t.editorMode === ("rich" as EditorMode) ? "split" as EditorMode : t.editorMode,
        isPinned: t.isPinned ?? false,
      }));
      set({ tabs: migratedTabs, activeTabId, themeId, graphData: buildGraphData(migratedTabs), sessionReady: true });
    },

  };
});
