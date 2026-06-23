// Detect which surface of the app a DOM event originated in.
// Used by global keyboard / context-menu handlers.

const matches = (t: EventTarget | null, selector: string) =>
  t instanceof Element && !!t.closest(selector);

export const isInEditor     = (t: EventTarget | null) => matches(t, ".monaco-editor");
export const isInPreview    = (t: EventTarget | null) => matches(t, ".prose-scroll");
export const isInTabBar     = (t: EventTarget | null) => matches(t, ".tab-strip");
export const isInWhiteboard = (t: EventTarget | null) => matches(t, ".excalidraw");
export const isInTerminal   = (t: EventTarget | null) => matches(t, ".terminal-xterm-wrap");
export const isInChat       = (t: EventTarget | null) => matches(t, ".ai-chat");
