import { useEffect, useMemo, useState } from "react";
import type { MouseEvent } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { RemoteFilesPanel } from "./RemoteFilesPanel";
import { WindowControls } from "../layout/WindowControls";
import { appWin } from "../../lib/tauriWindow";
import logoUrl from "../../assets/logo.png";
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
  // The same frameless header as the main window (brand, controls), so this window looks like part of the app.
  const onHeaderMouseDown = (e: MouseEvent<HTMLElement>) => {
    if (e.buttons !== 1 || (e.target as HTMLElement).closest("button, input, a, select")) return;
    if (e.detail === 2) void appWin?.toggleMaximize(); else void appWin?.startDragging();
  };
  return (
    <div className="h-screen w-screen flex flex-col bg-[var(--color-bg)]">
      <header className="app-header" onMouseDown={onHeaderMouseDown}>
        <div className="header-left">
          <div className="app-brand">
            <img src={logoUrl} alt="Notiq" draggable={false} className="app-brand-logo" />
            <span className="app-brand-name">Notiq</span>
          </div>
        </div>
        <div className="header-center">
          <span className="text-xs text-[var(--color-text-muted)] truncate px-2">Files · {target.title}</span>
        </div>
        <div className="header-right"><WindowControls onClose={() => void appWin?.close()} /></div>
      </header>
      <div className="flex-1 min-h-0"><RemoteFilesPanel target={target} /></div>
    </div>
  );
}
