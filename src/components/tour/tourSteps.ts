/**
 * Step definitions for the first-run welcome tour (see `Tour.tsx`).
 *
 * A step with a `selector` spotlights that element; a step without one renders a
 * centered card (welcome / finish). Steps whose selector isn't in the DOM at run
 * time are filtered out by `Tour.tsx`, so conditionally-rendered anchors are safe.
 */
export type TourPlacement = "top" | "bottom" | "left" | "right" | "center";

export interface TourStep {
  /** CSS selector for the element to spotlight. Omit for a centered card. */
  selector?: string;
  title: string;
  body: string;
  /** Preferred popover placement relative to the target. Default: "bottom". */
  placement?: TourPlacement;
}

export const TOUR_STEPS: TourStep[] = [
  {
    title: "Welcome to Notiq 👋",
    body: "A fast, offline-first, privacy-focused notes app. Here's a 30-second tour of the essentials.",
    placement: "center",
  },
  {
    selector: '[data-tour="nav-rail"]',
    title: "Navigation",
    body: "Switch between the Editor, the Knowledge Graph of your linked notes, and the Whiteboard from this rail.",
    placement: "right",
  },
  {
    selector: '[data-tour="editor"]',
    title: "Your editor",
    body: "Write in Markdown here. Use the mode picker in the title bar to switch between Source, Preview, and Split views.",
    placement: "bottom",
  },
  {
    selector: '[data-tour="ai-button"]',
    title: "AI assistance",
    body: "Optional and off by default. Click ✨ to set up inline autocomplete and AI actions — nothing leaves your machine until you opt in.",
    placement: "bottom",
  },
  {
    selector: '[data-tour="ai-chat"]',
    title: "AI chat",
    body: "Open a chat panel that can use your current note as context — ask questions, summarize, or draft right beside your work.",
    placement: "bottom",
  },
  {
    selector: '[data-tour="settings"]',
    title: "Settings & themes",
    body: "Settings opens as a tab (Ctrl+,) — search every option, from themes and editor behavior to AI, the vault and updates.",
    placement: "right",
  },
  {
    title: "You're all set 🎉",
    body: "Tip: press Ctrl+Shift+P anytime for the command palette. You can replay this tour from Settings → General.",
    placement: "center",
  },
];
