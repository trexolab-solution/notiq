import { emit } from "@tauri-apps/api/event";
import { applyTheme } from "../../lib/themes";
import { buildPreferenceSlice, resetAllPreferences } from "../preferences";
import type { SliceContext } from "./context";
import type { AppState } from "./state";

/** Every editor / terminal / AI / update preference (generated from the declarative registry). */
type PreferenceKeys =
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
  | "autoUpdateCheck" | "setAutoUpdateCheck";

export type AppearanceSlice = Pick<AppState, "themeId" | "setTheme" | "resetPreferences" | PreferenceKeys>;

/** Theme and preferences. */
export function createAppearanceSlice({ set, get, persist }: SliceContext): AppearanceSlice {
  return {
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
    ) as Pick<AppState, PreferenceKeys>),

    resetPreferences() {
      resetAllPreferences(set as (partial: Record<string, unknown>) => void);
    },
  };
}
