import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Lock, Search, Star } from "lucide-react";
import { applyTheme } from "../lib/themes";
import { copySecret } from "../lib/secureCopy";
import { resolveVaultDir } from "../lib/vaultDir";
import { ERR_LOCKED, vaultErrorMessage, vaultReadFile, vaultStatus } from "../lib/vault";
import { toFull } from "../lib/vaultTree";
import { EntryIcon } from "../components/vault/sidebar/EntryIcon";
import {
  copyFields, hasCopyableSecret, moveSelection, searchEntries, toResult, type IndexItem, type QuickResult,
} from "./rank";

type Phase = "loading" | "ready" | "locked" | "novault" | "error";
type ThemeId = Parameters<typeof applyTheme>[0];

/** Hides the window; `restore` gives the focus back to the app that was active before the hotkey. */
const hide = (restore: boolean) => invoke("quick_search_hide", { restore }).catch(() => {});
const showMain = (action: "open" | "unlock", rel?: string) =>
  invoke("quick_search_show_main", { action, rel: rel ?? null }).catch(() => {});

/**
 * The quick-search popup (window label `quick-search`, opened by the global hotkey).
 * Lists vault entries by name / type / folder / host only; secrets are read on demand when
 * copying and never rendered.
 */
export default function QuickSearchApp() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [items, setItems] = useState<QuickResult[]>([]);
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const [msg, setMsg] = useState<string | null>(null);
  const [visible, setVisible] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const hadFocus = useRef(false);
  const busy = useRef(false);

  const results = useMemo(() => searchEntries(items, query), [items, query]);
  const current = results[Math.min(sel, results.length - 1)] as QuickResult | undefined;

  const refresh = useCallback(async () => {
    try {
      const st = await vaultStatus();
      if (!st.exists) { setItems([]); setPhase("novault"); return; }
      if (!st.unlocked) { setItems([]); setPhase("locked"); return; }
      // Same folder the main window uses (a no-op when it is already set).
      await invoke("vault_set_root", { root: await resolveVaultDir() });
      const idx = await invoke<IndexItem[]>("quick_search_index");
      setItems(idx.map(toResult));
      setPhase("ready");
    } catch (e) {
      setItems([]);
      if (e === ERR_LOCKED) { setPhase("locked"); return; }
      setMsg(vaultErrorMessage(e));
      setPhase("error");
    }
  }, []);

  const close = useCallback((restore: boolean) => {
    setVisible(false);
    hadFocus.current = false;
    setQuery(""); setSel(0); setMsg(null);
    void hide(restore);
  }, []);

  // Theme (same source as the main window), initial load, and the "shown" event from Rust.
  useEffect(() => {
    document.documentElement.classList.add("is-quick-search");
    applyTheme((localStorage.getItem("pref:theme") || "dark") as ThemeId);
    void refresh();
    inputRef.current?.focus();
    const subs = [
      listen<{ themeId: string }>("theme-changed", (e) => applyTheme(e.payload.themeId as ThemeId)),
      listen("quick-search:shown", () => {
        setVisible(true);
        setQuery(""); setSel(0); setMsg(null);
        void refresh();
        requestAnimationFrame(() => inputRef.current?.focus());
      }),
      getCurrentWindow().onFocusChanged(({ payload: focused }) => {
        if (focused) { hadFocus.current = true; return; }
        // Clicked elsewhere: just hide, don't steal the focus back.
        if (hadFocus.current && !busy.current) close(false);
      }),
    ];
    return () => { subs.forEach((p) => p.then((un) => un()).catch(() => {})); };
  }, [refresh, close]);

  // While locked and on screen, notice the unlock done in the main window.
  useEffect(() => {
    if (phase !== "locked" || !visible) return;
    const t = setInterval(() => void refresh(), 1000);
    return () => clearInterval(t);
  }, [phase, visible, refresh]);

  // Keyboard focus follows the state: the search box when ready, else the window's button.
  useEffect(() => {
    if (!visible) return;
    const el = phase === "ready" ? inputRef.current : document.querySelector<HTMLElement>("button");
    el?.focus();
  }, [phase, visible]);

  useEffect(() => { setSel(0); }, [query]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const copy = async (r: QuickResult, which: "main" | "secondary") => {
    if (busy.current) return;
    busy.current = true;
    try {
      const f = await vaultReadFile(toFull(await resolveVaultDir(), r.rel));
      const field = copyFields(f.ext, f.content)[which];
      if (!field) {
        setMsg(which === "main" ? `"${r.name}" has nothing to copy` : `"${r.name}" has no ${r.kind === "secret" ? "env name" : "username"}`);
        return;
      }
      if (await copySecret(field.value, field.label, { quiet: true })) close(true);
      else setMsg("Couldn't copy to the clipboard");
    } catch (e) {
      if (e === ERR_LOCKED) { setItems([]); setPhase("locked"); return; }
      setMsg(vaultErrorMessage(e));
    } finally {
      busy.current = false;
    }
  };

  const open = (r: QuickResult) => { close(false); void showMain("open", r.rel); };

  // Esc works whatever has the focus (the search box is disabled while locked).
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); close(true); } };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [close]);

  const unlock = () => { setVisible(false); hadFocus.current = false; void showMain("unlock"); };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (phase !== "ready") return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => moveSelection(s, e.key === "ArrowDown" ? 1 : -1, results.length));
      return;
    }
    if (e.key === "Enter" && current) {
      e.preventDefault();
      if (e.altKey) open(current);
      else if (e.ctrlKey || e.metaKey) void copy(current, "secondary");
      else if (hasCopyableSecret(current.kind)) void copy(current, "main");
      else open(current); // notes have no secret: open them
    }
  };

  const mainLabel = current?.kind === "login" || current?.kind === "ssh" ? "password"
    : current?.kind === "secret" ? "key" : "open";
  const secondaryLabel = current?.kind === "secret" ? "env name" : "username";

  return (
    <div
      className="h-screen flex flex-col overflow-hidden bg-[var(--color-bg-secondary)] text-[var(--color-text)] border border-[var(--color-border)]"
      onKeyDown={onKeyDown}
    >
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-[var(--color-border)]" data-tauri-drag-region>
        <Search size={16} className="text-[var(--color-text-muted)] shrink-0" aria-hidden />
        <input
          ref={inputRef}
          autoFocus
          spellCheck={false}
          autoComplete="off"
          aria-label="Search the vault"
          placeholder={phase === "ready" ? "Search vault by name, tag or site…" : "Notiq quick search"}
          disabled={phase !== "ready"}
          className="flex-1 bg-transparent outline-none text-sm placeholder:text-[var(--color-text-muted)]"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setMsg(null); }}
        />
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {phase === "loading" && <p className="p-4 text-xs text-[var(--color-text-muted)]">Loading…</p>}

        {phase === "locked" && (
          <div className="h-full flex flex-col items-center justify-center gap-3 p-6 text-center">
            <Lock size={22} style={{ color: "var(--color-primary)" }} aria-hidden />
            <p className="text-sm font-semibold">Vault is locked</p>
            <p className="text-xs text-[var(--color-text-muted)]">Unlock it in Notiq; this list refreshes on its own.</p>
            <button
              type="button"
              autoFocus
              className="px-3 py-1.5 rounded-md text-xs font-medium bg-[var(--color-primary)] text-white hover:opacity-90"
              onClick={unlock}
            >
              Unlock
            </button>
          </div>
        )}

        {phase === "novault" && (
          <div className="h-full flex flex-col items-center justify-center gap-3 p-6 text-center">
            <p className="text-sm font-semibold">No vault yet</p>
            <p className="text-xs text-[var(--color-text-muted)]">Set up the Secure Vault in Notiq first.</p>
            <button
              type="button"
              className="px-3 py-1.5 rounded-md text-xs font-medium bg-[var(--color-primary)] text-white hover:opacity-90"
              onClick={unlock}
            >
              Open Notiq
            </button>
          </div>
        )}

        {phase === "ready" && results.length === 0 && (
          <p className="p-4 text-xs text-[var(--color-text-muted)]">
            {items.length === 0 ? "The vault is empty." : "No matching entries."}
          </p>
        )}

        {phase === "ready" && results.length > 0 && (
          <ul ref={listRef} role="listbox" aria-label="Vault entries" className="py-1">
            {results.map((r, i) => (
              <li
                key={r.rel}
                data-index={i}
                role="option"
                aria-selected={i === sel}
                className={`flex items-center gap-2.5 px-3 py-1.5 cursor-pointer select-none ${
                  i === sel ? "bg-[var(--color-bg-tertiary)]" : "hover:bg-[var(--color-bg-tertiary)]/60"
                }`}
                onMouseDown={(e) => e.preventDefault() /* keep the focus in the search box */}
                onClick={() => setSel(i)}
                onDoubleClick={() => (hasCopyableSecret(r.kind) ? void copy(r, "main") : open(r))}
              >
                <EntryIcon kind={r.kind} size={16} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-sm truncate">
                    <span className="truncate">{r.name}</span>
                    {r.starred && <Star size={11} className="shrink-0 text-[var(--color-warning)]" aria-label="Starred" />}
                  </div>
                  <div className="text-[11px] truncate text-[var(--color-text-muted)]">
                    {[r.host, r.folder].filter(Boolean).join("  ·  ") || " "}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}

        {phase === "error" && <p className="p-4 text-xs text-[var(--color-danger)]">{msg}</p>}
      </div>

      <div className="px-3 py-1.5 border-t border-[var(--color-border)] text-[11px] text-[var(--color-text-muted)] flex items-center gap-3">
        {msg && phase === "ready" ? (
          <span role="alert" className="text-[var(--color-danger)] truncate">{msg}</span>
        ) : phase === "ready" ? (
          <>
            <span><kbd>↵</kbd> {mainLabel === "open" ? "open" : `copy ${mainLabel}`}</span>
            <span><kbd>Ctrl+↵</kbd> copy {secondaryLabel}</span>
            <span><kbd>Alt+↵</kbd> open in Notiq</span>
            <span className="ml-auto"><kbd>Esc</kbd> close</span>
          </>
        ) : (
          <span className="ml-auto"><kbd>Esc</kbd> close</span>
        )}
      </div>
    </div>
  );
}
