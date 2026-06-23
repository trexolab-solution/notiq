import { useEffect, useRef } from "react";
import { loadSession } from "../lib/session";
import { useAppStore, flushPendingPersist, flushPendingGraphRebuild } from "../store";
import { scanOrphanTempFolders } from "../lib/attachments";

const WELCOME_CONTENT = `# Welcome to Notiq

Your fast, offline-first markdown editor and whiteboard — all your notes stay on your machine, always.

---

## Getting Started

- **Create a note** — \`Ctrl+N\` opens a fresh tab ready for writing
- **Create a whiteboard** — \`Ctrl+3\` opens a freeform drawing canvas
- **Open files** — \`Ctrl+O\` to open files, \`Ctrl+Shift+O\` to open an entire folder
- **Save your work** — \`Ctrl+S\` to save, \`Ctrl+Shift+S\` for Save As

## Writing in Markdown

Notiq supports **full GitHub-Flavored Markdown** — bold, italic, headings, lists, tables, task lists, and more. Use the **formatting toolbar** above or these shortcuts:

| Shortcut | Action |
|---|---|
| \`Ctrl+B\` | **Bold** |
| \`Ctrl+I\` | *Italic* |
| \`Ctrl+Alt+1/2/3\` | Headings |
| \`Ctrl+Shift+T\` | Insert table |
| \`Ctrl+Alt+C\` | Code block |
| \`Ctrl+K\` | Insert link |

Switch between **Source**, **Preview**, and **Split** view modes using the mode picker in the titlebar.

## Link Your Notes

Connect your notes with **wiki-links** — just type \`[[Note Title]]\` to link to another open note. Open the **Knowledge Graph** from the sidebar to visualize how your notes are connected.

## Whiteboards

Every whiteboard is powered by Excalidraw — sketch diagrams, flowcharts, or mind maps. You can even **link a whiteboard to a note** for quick navigation between the two.

## Mermaid Diagrams

Embed diagrams right in your notes using fenced code blocks:

\`\`\`mermaid
graph LR
  A[Idea] --> B[Draft] --> C[Publish]
\`\`\`

## Make It Yours

- **Themes** — 13+ themes (Dracula, Nord, Catppuccin, Tokyo Night, and more) — switch from the sidebar
- **Settings** — \`Ctrl+,\` to adjust font size, font family, word wrap, line numbers, and default view mode
- **Export PDF** — \`Ctrl+P\` to export your note as a PDF

## Quick Reference

| Shortcut | Action |
|---|---|
| \`Ctrl+N\` | New note |
| \`Ctrl+3\` | New whiteboard |
| \`Ctrl+O\` | Open file(s) |
| \`Ctrl+Shift+O\` | Open folder |
| \`Ctrl+S\` | Save |
| \`Ctrl+W\` | Close tab |
| \`Ctrl+Tab\` | Next tab |
| \`Ctrl+P\` | Export PDF |
| \`Ctrl+,\` | Settings |

---

*This note is just a regular note — feel free to edit or delete it. Happy writing!*
`;

export function useSession() {
  const hydrate = useAppStore((s) => s.hydrate);
  const addTab = useAppStore((s) => s.addTab);
  const loaded = useRef(false);

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;

    loadSession().then((session) => {
      if (session && session.tabs.length > 0) {
        hydrate(session.tabs, session.activeTabId, session.themeId);
      } else {
        addTab({ title: "Welcome to Notiq", content: WELCOME_CONTENT });
      }
      // Reap orphaned per-tab temp attachment folders from prior sessions
      const activeIds = new Set(useAppStore.getState().tabs.map((t) => t.id));
      scanOrphanTempFolders(activeIds).catch((e) => console.warn("orphan scan failed", e));
    }).catch(() => {
      // Ensure the window still shows even if hydration fails
      useAppStore.setState({ sessionReady: true });
    });
  }, []); // Init-once: hydrate/addTab are stable Zustand actions

  // Flush any pending timers on window close — Notepad++ behaviour
  useEffect(() => {
    const onBeforeUnload = () => {
      flushPendingPersist();
      flushPendingGraphRebuild();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);
}
