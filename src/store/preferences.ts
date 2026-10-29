import type {
  EditorMode, AutoClosingBrackets, RenderWhitespace, RenderLineHighlight,
  EditorCursorStyle, EditorCursorBlinking, TerminalCursorStyle, TerminalLayout,
} from "../types";

// ─── coercion helpers ────────────────────────────────────────────────────────

type Coercion = "number" | "bool-true" | "bool-false" | "string";

function readPref(storageKey: string, defaultValue: unknown, coercion: Coercion): unknown {
  const raw = localStorage.getItem(storageKey);
  if (raw === null) return defaultValue;
  switch (coercion) {
    case "number": {
      const num = Number(raw);
      return Number.isFinite(num) ? num : defaultValue;
    }
    case "bool-true":  return raw !== "false";   // default true  → stored "false" is the only falsy value
    case "bool-false": return raw === "true";    // default false → stored "true" is the only truthy value
    case "string":     return raw || defaultValue;
  }
}

// ─── preference definitions ──────────────────────────────────────────────────

interface PrefDef {
  stateKey: string;
  storageKey: string;
  defaultValue: unknown;
  coercion: Coercion;
}

const PREFERENCE_DEFS: PrefDef[] = [
  // Editor — Font & Display
  { stateKey: "editorFontSize",         storageKey: "pref:fontSize",               defaultValue: 15,                           coercion: "number" },
  { stateKey: "wordWrap",               storageKey: "pref:wordWrap",               defaultValue: true,                         coercion: "bool-true" },
  { stateKey: "showLineNumbers",        storageKey: "pref:lineNumbers",            defaultValue: true,                         coercion: "bool-true" },
  { stateKey: "fontFamily",             storageKey: "pref:fontFamily",             defaultValue: "'JetBrains Mono', monospace", coercion: "string" },
  { stateKey: "tabSize",                storageKey: "pref:tabSize",                defaultValue: 2,                            coercion: "number" },
  { stateKey: "letterSpacing",          storageKey: "pref:letterSpacing",          defaultValue: 0.2,                          coercion: "number" },

  // Editor — Display
  { stateKey: "minimap",                storageKey: "pref:minimap",                defaultValue: false,                        coercion: "bool-false" },
  { stateKey: "bracketPairColorization", storageKey: "pref:bracketPairColorization", defaultValue: true,                       coercion: "bool-true" },
  { stateKey: "formatOnPaste",          storageKey: "pref:formatOnPaste",          defaultValue: true,                         coercion: "bool-true" },
  { stateKey: "autoClosingBrackets",    storageKey: "pref:autoClosingBrackets",    defaultValue: "always",                     coercion: "string" },
  { stateKey: "renderWhitespace",       storageKey: "pref:renderWhitespace",       defaultValue: "none",                       coercion: "string" },
  { stateKey: "smoothScrolling",        storageKey: "pref:smoothScrolling",        defaultValue: true,                         coercion: "bool-true" },
  { stateKey: "mouseWheelScrollSensitivity", storageKey: "pref:mwScrollSensitivity", defaultValue: 1,                            coercion: "number" },
  { stateKey: "scrollBeyondLastLine",   storageKey: "pref:scrollBeyondLastLine",   defaultValue: false,                        coercion: "bool-false" },
  { stateKey: "folding",                storageKey: "pref:folding",                defaultValue: true,                         coercion: "bool-true" },
  { stateKey: "renderLineHighlight",    storageKey: "pref:renderLineHighlight",    defaultValue: "line",                       coercion: "string" },

  // Editor — Cursor
  { stateKey: "cursorStyle",            storageKey: "pref:cursorStyle",            defaultValue: "line",                       coercion: "string" },
  { stateKey: "cursorBlinking",         storageKey: "pref:cursorBlinking",         defaultValue: "smooth",                     coercion: "string" },

  // Terminal
  { stateKey: "terminalFontSize",       storageKey: "pref:termFontSize",           defaultValue: 13,                           coercion: "number" },
  { stateKey: "terminalCursorStyle",    storageKey: "pref:termCursorStyle",        defaultValue: "block",                      coercion: "string" },
  { stateKey: "terminalCursorBlink",    storageKey: "pref:termCursorBlink",        defaultValue: true,                         coercion: "bool-true" },
  { stateKey: "terminalScrollback",     storageKey: "pref:termScrollback",         defaultValue: 5000,                         coercion: "number" },
  { stateKey: "terminalLayout",         storageKey: "pref:termLayout",             defaultValue: "horizontal",                 coercion: "string" },

  // AI / Autocomplete (the API key is NOT stored here — it lives in the OS keyring).
  // NOTE: aiProvider/aiModel are hand-written below buildPreferenceSlice's loop
  // (see the "aiProvider / aiModel" block) since they need cross-field logic —
  // switching provider restores that provider's remembered model. Kept out of
  // this generic registry for that reason, same as `defaultEditorMode` below.
  { stateKey: "aiEnabled",              storageKey: "pref:aiEnabled",              defaultValue: false,                        coercion: "bool-false" },
  { stateKey: "aiModelCloud",           storageKey: "pref:aiModelCloud",           defaultValue: "",                           coercion: "string" },
  { stateKey: "aiModelLocal",           storageKey: "pref:aiModelLocal",           defaultValue: "",                           coercion: "string" },
  { stateKey: "aiModelOpenrouter",      storageKey: "pref:aiModelOpenrouter",      defaultValue: "",                           coercion: "string" },
  { stateKey: "aiFallbackProvider",     storageKey: "pref:aiFallbackProvider",     defaultValue: "none",                       coercion: "string" },
  { stateKey: "aiFallbackModel",        storageKey: "pref:aiFallbackModel",        defaultValue: "",                           coercion: "string" },
  { stateKey: "aiAutocompleteEnabled",  storageKey: "pref:aiAutocomplete",         defaultValue: true,                         coercion: "bool-true" },
  { stateKey: "aiTriggerMode",          storageKey: "pref:aiTriggerMode",          defaultValue: "auto",                       coercion: "string" },
  { stateKey: "aiDebounceMs",           storageKey: "pref:aiDebounceMs",           defaultValue: 400,                          coercion: "number" },
  { stateKey: "aiContextLines",         storageKey: "pref:aiContextLines",         defaultValue: 40,                           coercion: "number" },
  { stateKey: "aiOnboarded",            storageKey: "pref:aiOnboarded",            defaultValue: false,                        coercion: "bool-false" },

  // Updates
  { stateKey: "autoUpdateCheck",        storageKey: "pref:autoUpdateCheck",        defaultValue: true,                         coercion: "bool-true" },
];

/** Default value of every standard preference (plus `defaultEditorMode`), keyed by state key — for "modified" / Reset in Settings. */
export const PREFERENCE_DEFAULTS: Readonly<Record<string, unknown>> = Object.freeze({
  ...Object.fromEntries(PREFERENCE_DEFS.map((d) => [d.stateKey, d.defaultValue])),
  defaultEditorMode: "split",
});

// ─── setter name helper ─────────────────────────────────────────────────────

function setterName(stateKey: string): string {
  return "set" + stateKey.charAt(0).toUpperCase() + stateKey.slice(1);
}

// ─── slice builder ───────────────────────────────────────────────────────────

/** Maps an AI provider id to the storage key remembering that provider's last-picked model. */
const MODEL_STATE_KEY: Record<string, string> = {
  cloud: "aiModelCloud", local: "aiModelLocal", openrouter: "aiModelOpenrouter",
};
const MODEL_STORAGE_KEY: Record<string, string> = {
  cloud: "pref:aiModelCloud", local: "pref:aiModelLocal", openrouter: "pref:aiModelOpenrouter",
};

/**
 * Generates initial values + setter functions for the standard preferences.
 * `defaultEditorMode` and `aiProvider`/`aiModel` are handled separately below —
 * the former for its one-time value migration, the latter because switching
 * provider needs to restore that provider's own remembered model.
 */
export function buildPreferenceSlice(
  set: (partial: Record<string, unknown>) => void,
  get: () => Record<string, unknown>,
): Record<string, unknown> {
  const slice: Record<string, unknown> = {};

  for (const def of PREFERENCE_DEFS) {
    // initial value
    slice[def.stateKey] = readPref(def.storageKey, def.defaultValue, def.coercion);
    // setter
    slice[setterName(def.stateKey)] = (v: unknown) => {
      localStorage.setItem(def.storageKey, String(v));
      set({ [def.stateKey]: v });
    };
  }

  // defaultEditorMode — special migration: "rich" → "split"
  const rawMode = localStorage.getItem("pref:defaultMode");
  slice.defaultEditorMode = (rawMode === "rich" || !rawMode) ? "split" : rawMode as EditorMode;
  slice.setDefaultEditorMode = (mode: EditorMode) => {
    localStorage.setItem("pref:defaultMode", mode);
    set({ defaultEditorMode: mode });
  };

  // aiProvider / aiModel — the "current" model always tracks whichever provider
  // is selected, backed by per-provider storage (aiModelCloud/Local/Openrouter)
  // so switching providers back and forth restores each one's last choice.
  const initialProvider = localStorage.getItem("pref:aiProvider") || "cloud";

  // One-time migration: an older build stored a single flat `pref:aiModel` with
  // no provider association. Seed it into the matching per-provider slot (only
  // if that slot is still empty, so it never clobbers a real per-provider value)
  // then stop writing the legacy key.
  const legacyModel = localStorage.getItem("pref:aiModel");
  if (legacyModel && !localStorage.getItem(MODEL_STORAGE_KEY[initialProvider])) {
    localStorage.setItem(MODEL_STORAGE_KEY[initialProvider], legacyModel);
    slice[MODEL_STATE_KEY[initialProvider]] = legacyModel;
  }
  localStorage.removeItem("pref:aiModel");

  slice.aiProvider = initialProvider;
  slice.aiModel = (slice[MODEL_STATE_KEY[initialProvider]] as string) ?? "";

  slice.setAiProvider = (v: string) => {
    localStorage.setItem("pref:aiProvider", v);
    set({ aiProvider: v, aiModel: (get()[MODEL_STATE_KEY[v]] as string) ?? "" });
  };
  slice.setAiModel = (v: string) => {
    const provider = get().aiProvider as string;
    localStorage.setItem(MODEL_STORAGE_KEY[provider], v);
    set({ aiModel: v, [MODEL_STATE_KEY[provider]]: v });
  };

  return slice;
}

/**
 * Reset every preference back to its default value.
 * Clears localStorage entries and pushes defaults into the zustand store.
 * `defaultEditorMode` (handled separately above) is reset too.
 */
export function resetAllPreferences(set: (partial: Record<string, unknown>) => void): void {
  const updates: Record<string, unknown> = {};
  for (const def of PREFERENCE_DEFS) {
    localStorage.removeItem(def.storageKey);
    updates[def.stateKey] = def.defaultValue;
  }
  localStorage.removeItem("pref:defaultMode");
  updates.defaultEditorMode = "split";

  localStorage.removeItem("pref:aiProvider");
  updates.aiProvider = "cloud";
  updates.aiModel = "";

  set(updates);
}

// Re-export types used by the interface for convenience
export type {
  EditorMode, AutoClosingBrackets, RenderWhitespace, RenderLineHighlight,
  EditorCursorStyle, EditorCursorBlinking, TerminalCursorStyle, TerminalLayout,
};
