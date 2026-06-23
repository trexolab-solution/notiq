import {
  useEffect, useRef, useCallback, forwardRef, useImperativeHandle, useState,
} from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Clipboard, Copy, Trash2, SquareMousePointer } from "lucide-react";
import { useAppStore } from "../../store";
import { THEMES } from "../../lib/themes";
import type { ThemeId } from "../../types";
import { ContextMenu, type ContextMenuItem } from "../ui/ContextMenu";

export interface InstanceHandle {
  fit():   void;
  focus(): void;
}

interface Props {
  sessionId:   number;
  isActive:    boolean;
  isOpen:      boolean;
  onShellName: (id: number, name: string) => void;
  onExit:      (id: number) => void;
  onFocus?:    (id: number) => void;
}

interface TermCtxMenuState {
  x: number;
  y: number;
}

export const TerminalInstance = forwardRef<InstanceHandle, Props>(
  function TerminalInstance({ sessionId, isActive, isOpen, onShellName, onExit, onFocus }, ref) {
    const themeId             = useAppStore((s) => s.themeId);
    const terminalFontSize    = useAppStore((s) => s.terminalFontSize);
    const terminalCursorStyle = useAppStore((s) => s.terminalCursorStyle);
    const terminalCursorBlink = useAppStore((s) => s.terminalCursorBlink);
    const terminalScrollback  = useAppStore((s) => s.terminalScrollback);

    const containerRef   = useRef<HTMLDivElement>(null);
    const termRef        = useRef<Terminal | null>(null);
    const fitAddonRef    = useRef<FitAddon | null>(null);
    const shellExitedRef = useRef(false);
    const onFocusRef     = useRef<((id: number) => void) | undefined>(onFocus);
    onFocusRef.current   = onFocus;

    const [ctxMenu, setCtxMenu] = useState<TermCtxMenuState | null>(null);

    // ── Restart (stable — only refs + prop primitives as deps) ────────────
    const handleRestart = useCallback(async () => {
      shellExitedRef.current = false;
      await invoke("terminal_kill", { id: sessionId }).catch(console.error);
      termRef.current?.reset();
      const t = termRef.current;
      if (!t) return;
      const name = await invoke<string>("terminal_create", {
        id: sessionId, cols: t.cols, rows: t.rows,
      }).catch(() => "");
      if (name) onShellName(sessionId, name);
      t.focus();
    }, [sessionId, onShellName]);

    useImperativeHandle(ref, () => ({
      fit()   { fitAddonRef.current?.fit();  },
      focus() { termRef.current?.focus();    },
    }));

    // Focus when this session becomes active
    useEffect(() => {
      if (isActive && isOpen) {
        requestAnimationFrame(() => {
          fitAddonRef.current?.fit();
          termRef.current?.focus();
        });
      }
    }, [isActive, isOpen]);

    // ── Mount xterm once ──────────────────────────────────────────────────
    useEffect(() => {
      if (!containerRef.current) return;

      const store = useAppStore.getState();
      const currentTheme = THEMES[store.themeId as ThemeId] ?? THEMES.dark;
      const term = new Terminal({
        fontFamily:      '"Cascadia Code", "JetBrains Mono", "Fira Code", Consolas, monospace',
        fontSize:        store.terminalFontSize,
        lineHeight:      1.2,
        cursorBlink:     store.terminalCursorBlink,
        cursorStyle:     store.terminalCursorStyle,
        scrollback:      store.terminalScrollback,
        tabStopWidth:    4,
        macOptionIsMeta: true,
        theme: {
          background:          currentTheme.colors.editorBg,
          foreground:          currentTheme.colors.editorText,
          cursor:              currentTheme.colors.primary,
          cursorAccent:        currentTheme.colors.editorBg,
          selectionBackground: "rgba(38,79,120,0.5)",
          ...currentTheme.ansi,
        },
      });

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(containerRef.current);
      fitAddon.fit();

      termRef.current     = term;
      fitAddonRef.current = fitAddon;

      // ── Spawn PTY for this session ─────────────────────────────────────
      invoke<string>("terminal_create", {
        id: sessionId, cols: term.cols, rows: term.rows,
      }).then((name) => { if (name) onShellName(sessionId, name); })
        .catch(console.error);

      // ── Stream PTY output (filtered by session ID) ─────────────────────
      let cancelled = false;
      let unlistenData: (() => void) | undefined;
      let unlistenExit: (() => void) | undefined;

      listen<{ id: number; data: string }>("terminal-data", (ev) => {
        if (ev.payload.id === sessionId) termRef.current?.write(ev.payload.data);
      }).then((fn) => { if (cancelled) fn(); else unlistenData = fn; });

      // ── Shell exit notification ────────────────────────────────────────
      listen<{ id: number }>("terminal-exit", (ev) => {
        if (ev.payload.id !== sessionId) return;
        shellExitedRef.current = true;
        termRef.current?.writeln(
          "\r\n\x1b[2m[Process exited — press any key to restart]\x1b[0m",
        );
        onExit(sessionId);
      }).then((fn) => { if (cancelled) fn(); else unlistenExit = fn; });

      // ── Input → PTY (auto-restart on any key after exit) ──────────────
      term.onData((data) => {
        if (shellExitedRef.current) { handleRestart(); return; }
        invoke("terminal_write", { id: sessionId, data }).catch(console.error);
      });

      // ── Sync PTY dimensions on resize ─────────────────────────────────
      term.onResize(({ cols: c, rows: r }) => {
        invoke("terminal_resize", { id: sessionId, cols: c, rows: r }).catch(console.error);
      });

      // ── Notify parent when this terminal gains focus (used for active pane) ──
      term.textarea?.addEventListener("focus", () => {
        onFocusRef.current?.(sessionId);
      });

      // ── Ctrl+V → clipboard paste ───────────────────────────────────────
      // preventDefault() stops the browser's native paste from also firing —
      // without it xterm processes both, causing a double paste.
      term.attachCustomKeyEventHandler((ev) => {
        if (ev.type === "keydown" && ev.ctrlKey && !ev.shiftKey && ev.key === "v") {
          ev.preventDefault();
          readText()
            .then((t) => {
              if (t) invoke("terminal_write", { id: sessionId, data: t }).catch(console.error);
            })
            .catch(() => {});
          return false;
        }
        return true;
      });

      // ── Re-fit when container resizes ─────────────────────────────────
      let fitTimer: ReturnType<typeof setTimeout>;
      const observer = new ResizeObserver(() => {
        if (containerRef.current && containerRef.current.offsetHeight > 10) {
          clearTimeout(fitTimer);
          fitTimer = setTimeout(() => fitAddonRef.current?.fit(), 40);
        }
      });
      observer.observe(containerRef.current);

      return () => {
        cancelled = true;
        unlistenData?.();
        unlistenExit?.();
        observer.disconnect();
        clearTimeout(fitTimer);
        term.dispose();
        termRef.current     = null;
        fitAddonRef.current = null;
      };
    }, []); // Init-once: PTY setup uses refs for all mutable state

    // ── Sync theme colors when theme changes ──────────────────────────────
    useEffect(() => {
      const t = termRef.current;
      if (!t) return;
      const theme = THEMES[themeId as ThemeId] ?? THEMES.dark;
      t.options.theme = {
        background:          theme.colors.editorBg,
        foreground:          theme.colors.editorText,
        cursor:              theme.colors.primary,
        cursorAccent:        theme.colors.editorBg,
        selectionBackground: "rgba(38,79,120,0.5)",
        ...theme.ansi,
      };
    }, [themeId]);

    // ── Sync settings at runtime when they change ─────────────────────────
    useEffect(() => {
      const t = termRef.current;
      if (!t) return;
      t.options.fontSize    = terminalFontSize;
      t.options.cursorStyle = terminalCursorStyle;
      t.options.cursorBlink = terminalCursorBlink;
      t.options.scrollback  = terminalScrollback;
      fitAddonRef.current?.fit();
    }, [terminalFontSize, terminalCursorStyle, terminalCursorBlink, terminalScrollback]);

    // ── Right-click: show context menu ──────────────────────────────────────
    const handleContextMenu = useCallback((e: React.MouseEvent) => {
      e.preventDefault();
      setCtxMenu({ x: e.clientX, y: e.clientY });
    }, []);

    // ── Terminal context menu actions ────────────────────────────────────────
    const handleCopy = useCallback(async () => {
      const t = termRef.current;
      if (!t) return;
      if (t.hasSelection()) {
        await writeText(t.getSelection()).catch(() => {});
        t.clearSelection();
      }
      t.focus();
    }, []);

    const handlePaste = useCallback(async () => {
      const text = await readText().catch(() => "");
      if (text) invoke("terminal_write", { id: sessionId, data: text }).catch(console.error);
      termRef.current?.focus();
    }, [sessionId]);

    const handleSelectAll = useCallback(() => {
      termRef.current?.selectAll();
      termRef.current?.focus();
    }, []);

    const handleClear = useCallback(() => {
      termRef.current?.clear();
      termRef.current?.focus();
    }, []);

    const hasSelection = termRef.current?.hasSelection() ?? false;

    const ctxMenuItems: ContextMenuItem[] = [
      { type: "item", label: "Copy",       icon: <Copy size={13} />,                shortcut: "Ctrl+C", disabled: !hasSelection, onClick: handleCopy },
      { type: "item", label: "Paste",      icon: <Clipboard size={13} />,           shortcut: "Ctrl+V", onClick: handlePaste },
      { type: "separator" },
      { type: "item", label: "Select All", icon: <SquareMousePointer size={13} />,  onClick: handleSelectAll },
      { type: "item", label: "Clear",      icon: <Trash2 size={13} />,              onClick: handleClear },
    ];

    return (
      <div
        className="terminal-instance"
        style={{ display: isActive ? "flex" : "none" }}
      >
        <div
          className="terminal-xterm-wrap"
          ref={containerRef}
          onContextMenu={handleContextMenu}
        />
        {ctxMenu && (
          <ContextMenu
            x={ctxMenu.x}
            y={ctxMenu.y}
            items={ctxMenuItems}
            onClose={() => { setCtxMenu(null); termRef.current?.focus(); }}
          />
        )}
      </div>
    );
  },
);
