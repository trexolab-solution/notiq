import { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { RemoteFilesPanel } from "./RemoteFilesPanel";
import { parseFilesHash } from "../../lib/remoteFilesWindow";
import { dragLeave, dragMove, dropAt } from "../../lib/dropTargets";
import { applyTheme } from "../../lib/themes";

/**
 * The remote file manager in a window of its own (opened from the sidebar or the setting "Open file manager in:
 * New window"). It mounts only the file manager: none of the main window's hooks (auto-lock, updater, tour).
 * The vault stays unlocked and the connection lives in the backend, so it works exactly like the tab.
 */
export default function RemoteFilesApp() {
  const target = useMemo(() => parseFilesHash(window.location.hash), []);
  const [, setTheme] = useState(0);

  // The theme of the main window, now and when it changes.
  useEffect(() => {
    applyTheme((localStorage.getItem("pref:theme") || "dark") as Parameters<typeof applyTheme>[0]);
    let off: (() => void) | undefined;
    let dead = false;
    void listen<{ themeId: string }>("theme-changed", (e) => {
      applyTheme(e.payload.themeId as Parameters<typeof applyTheme>[0]);
      setTheme((n) => n + 1);
    }).then((u) => { if (dead) u(); else off = u; });
    return () => { dead = true; off?.(); };
  }, []);

  // Files dragged from the desktop go to the panel's drop target, like in the main window.
  useEffect(() => {
    let off: (() => void) | undefined;
    let dead = false;
    void getCurrentWebview().onDragDropEvent((event) => {
      const p = event.payload;
      if (p.type === "enter" || p.type === "over") dragMove(p.position);
      else if (p.type === "leave") dragLeave();
      else if (p.type === "drop") dropAt(p.paths, p.position);
    }).then((u) => { if (dead) u(); else off = u; });
    return () => { dead = true; off?.(); };
  }, []);

  if (!target) {
    return <p className="p-6 text-sm text-[var(--color-text-muted)]">This window wasn't opened for a server. Close it and use “Open file manager” on a saved SSH entry.</p>;
  }
  return <div className="h-screen w-screen"><RemoteFilesPanel target={target} /></div>;
}
