import { panelWidth } from "./panelWidth";

/** Vault entry History side panel width (per-device, localStorage like the other prefs). */

export const HISTORY_PANEL_KEY = "pref:vaultHistoryPanelWidth";
export const HISTORY_PANEL_DEFAULT = 340;
/** Version list + preview stay usable down to this. */
export const HISTORY_PANEL_MIN = 260;
export const HISTORY_PANEL_MAX = 640;
/** The entry form next to the panel never gets narrower than this. */
export const HISTORY_FORM_MIN = 360;
/** Gap left on the form's side when the panel overlays it, so it still reads as a panel. */
const OVERLAY_GUTTER = 32;

/** Too narrow to show the form at its minimum beside the panel: the panel overlays the form instead. */
export const historyPanelOverlays = (containerWidth: number) =>
  !(containerWidth >= HISTORY_FORM_MIN + HISTORY_PANEL_MIN);

export const historyPanelWidth = panelWidth({
  key: HISTORY_PANEL_KEY,
  min: HISTORY_PANEL_MIN,
  def: HISTORY_PANEL_DEFAULT,
  step: 16,
  maxFor: (containerWidth) => Math.min(
    HISTORY_PANEL_MAX,
    containerWidth - (historyPanelOverlays(containerWidth) ? OVERLAY_GUTTER : HISTORY_FORM_MIN),
  ),
});
