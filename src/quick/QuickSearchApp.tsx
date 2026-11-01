import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWindowContextMenu } from "../hooks/useWindowContextMenu";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Copy, Hourglass, Lock, Search, Star } from "lucide-react";
import { InlineLoading } from "../components/ui/Loading";
import { applyTheme } from "../lib/themes";
import { copiedMessage, copySecret, copySecretTimed } from "../lib/secureCopy";
import { resolveVaultDir } from "../lib/vaultDir";
import { ERR_LOCKED, vaultErrorMessage, vaultReadFile, vaultStatus } from "../lib/vault";
import { toFull } from "../lib/vaultTree";
import { EntryIcon } from "../components/vault/sidebar/EntryIcon";
import { TotpRing } from "../components/ui/TotpRing";
import {
  copyFields, hasCopyableSecret, moveSelection, searchEntries, toResult, type IndexItem, type QuickResult,
} from "./rank";
import {
  codeLabel, codeTargets, copyPlan, formatCode, msUntilNextStep, NEAR_EXPIRY_SECONDS, secondsLeft, TOTP_PERIOD,
  totpStep, waitingMessage, type TotpNow,
} from "./totp";

type Phase = "loading" | "ready" | "locked" | "novault" | "error";
type ThemeId = Parameters<typeof applyTheme>[0];

/** Hides the window; `restore` gives the focus back to the app that was active before the hotkey. */
const hide = (restore: boolean) => invoke("quick_search_hide", { restore }).catch(() => {});
/** Tells Rust the page listens (after mount and on every show): it shows the window only then. */
const ready = () => invoke("quick_search_ready").catch(() => {});
const showMain = (action: "open" | "unlock", rel?: string) =>
  invoke("quick_search_show_main", { action, rel: rel ?? null }).catch(() => {});

/**
 * The quick-search popup (window label `quick-search`, opened by the global hotkey).
 * Lists vault entries by name / type / folder / host only; secrets are read on demand when
 * copying and never rendered. The one exception is a login's live 2FA code (shown with its
 * countdown): it comes from `quick_search_totp` (the TOTP secret never reaches this window) and is
 * dropped, with every timer, as soon as the window hides or the vault locks.
 */
export default function QuickSearchApp() {
  const ctxMenu = useWindowContextMenu();
  const [phase, setPhase] = useState<Phase>("loading");
  const [items, setItems] = useState<QuickResult[]>([]);
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const [msg, setMsg] = useState<string | null>(null);
  const [visible, setVisible] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const busy = useRef(false);
  // 2FA codes of the visible / selected logins, each valid for one TOTP step. Only codes, never
  // secrets; dropped (and every timer stopped) whenever the window hides or the vault locks.
  const [codes, setCodes] = useState<Record<string, { code: string; step: number }>>({});
  const [now, setNow] = useState(() => Date.now());
  /** Non-error footer status ("2FA code copied — clears in 30 s"). Never holds a code. */
  const [note, setNote] = useState<string | null>(null);
  /** A 2FA copy waiting for the next code (near expiry). */
  const [waitingRel, setWaitingRel] = useState<string | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const fetching = useRef(new Set<string>());
  /** Bumped on every reset so a reply that arrives after a hide / lock is dropped. */
  const gen = useRef(0);

  const results = useMemo(() => searchEntries(items, query), [items, query]);
  const current = results[Math.min(sel, results.length - 1)] as QuickResult | undefined;

  /** Forgets every code and stops the 2FA timers (window hidden, vault locked). */
  const dropCodes = useCallback(() => {
    gen.current += 1;
    timers.current.forEach(clearTimeout);
    timers.current = [];
    fetching.current.clear();
    setCodes({});
    setWaitingRel(null);
    setNote(null);
    busy.current = false;
  }, []);

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
    setQuery(""); setSel(0); setMsg(null);
    dropCodes();
    void hide(restore);
  }, [dropCodes]);

  const lockedNow = useCallback(() => { dropCodes(); setItems([]); setPhase("locked"); }, [dropCodes]);

  // Theme (same source as the main window), initial load, and the "shown" event from Rust.
  useEffect(() => {
    document.documentElement.classList.add("is-quick-search");
    applyTheme((localStorage.getItem("pref:theme") || "dark") as ThemeId);
    void refresh();
    inputRef.current?.focus();
    const subs = [
      listen<{ themeId: string }>("theme-changed", (e) => applyTheme(e.payload.themeId as ThemeId)),
      listen("quick-search:shown", () => {
        void ready();
        dropCodes();
        setVisible(true);
        setQuery(""); setSel(0); setMsg(null);
        void refresh();
        requestAnimationFrame(() => inputRef.current?.focus());
      }),
      // Rust hid the window (outside click, hotkey pressed again, Alt+F4, quick search turned off,
      // entry opened): forget the codes, the query and any message.
      listen("quick-search:hidden", () => {
        setVisible(false);
        setQuery(""); setSel(0); setMsg(null);
        dropCodes();
      }),
      // Locked anywhere (main window, panic lock, idle lock): no code stays on screen.
      listen<{ unlocked: boolean }>("vault:state-changed", (e) => { if (!e.payload.unlocked) lockedNow(); }),
      // An outside click (focus loss) is handled in Rust (`on_window_event`): it works even while
      // this page is still loading or has died, and it can't miss a focus gained before mount.
    ];
    let cancelled = false;
    void Promise.all(subs).then(() => { if (!cancelled) void ready(); }, () => { if (!cancelled) void ready(); });
    return () => { cancelled = true; subs.forEach((p) => p.then((un) => un()).catch(() => {})); };
  }, [refresh, dropCodes, lockedNow]);

  // Live 2FA codes: only for the logins on screen + the selected one, only while shown and unlocked.
  const targets = useMemo(
    () => (phase === "ready" && visible ? codeTargets(results, sel) : []),
    [phase, visible, results, sel],
  );
  const targetsKey = targets.join("\n");
  const ticking = targets.length > 0 || waitingRel !== null;
  const step = totpStep(now);

  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [ticking]);

  useEffect(() => {
    if (!targetsKey) return;
    for (const rel of targetsKey.split("\n")) {
      if (codes[rel]?.step === step || fetching.current.has(rel)) continue;
      fetching.current.add(rel);
      const g = gen.current;
      // Labelled with the step at request time: if a step boundary passes meanwhile, the next
      // render sees a stale step and fetches again.
      const asked = totpStep(Date.now());
      invoke<TotpNow>("quick_search_totp", { rel })
        .then((t) => t.code, (e) => {
          if (e === ERR_LOCKED && g === gen.current) lockedNow();
          return ""; // shown as a placeholder; retried next step
        })
        .then((code) => {
          if (g !== gen.current) return;
          fetching.current.delete(rel);
          setCodes((c) => ({ ...c, [rel]: { code, step: asked } }));
        });
    }
  }, [targetsKey, step, codes, lockedNow]);

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
    const g = gen.current;
    try {
      const f = await vaultReadFile(toFull(await resolveVaultDir(), r.rel));
      if (g !== gen.current) return; // hidden (clicked away) or locked meanwhile: copy nothing
      const field = copyFields(f.ext, f.content)[which];
      if (!field) {
        setMsg(which === "main" ? `"${r.name}" has nothing to copy` : `"${r.name}" has no ${r.kind === "secret" ? "env name" : "username"}`);
        return;
      }
      if (await copySecret(field.value, field.label, { quiet: true })) close(true);
      else setMsg("Couldn't copy to the clipboard");
    } catch (e) {
      if (g !== gen.current) return;
      if (e === ERR_LOCKED) { setItems([]); setPhase("locked"); return; }
      setMsg(vaultErrorMessage(e));
    } finally {
      if (g === gen.current) busy.current = false;
    }
  };

  /** Copies the code fresh from the vault (not the cached one), confirms briefly, then hides. */
  const copyCodeNow = async (r: QuickResult) => {
    if (busy.current) return;
    busy.current = true;
    const g = gen.current;
    let closing = false;
    try {
      const t = await invoke<TotpNow>("quick_search_totp", { rel: r.rel });
      if (g !== gen.current) return; // hidden or locked meanwhile
      const secs = await copySecretTimed(t.code, "2FA code", { quiet: true });
      if (secs === null) { setMsg("Couldn't copy to the clipboard"); return; }
      setMsg(null);
      setNote(copiedMessage("2FA code", secs));
      closing = true; // stay "busy" so a second Enter doesn't start another copy before the close
      timers.current.push(setTimeout(() => close(true), 700));
    } catch (e) {
      if (g !== gen.current) return;
      if (e === ERR_LOCKED) { lockedNow(); return; }
      setMsg(vaultErrorMessage(e));
    } finally {
      if (!closing && g === gen.current) busy.current = false;
    }
  };

  /** Shift+Enter / the row's code button. Near expiry it waits for the next code (see `copyPlan`). */
  const copyCode = (r: QuickResult) => {
    if (busy.current || waitingRel) return;
    if (!r.totp) { setMsg(`"${r.name}" has no 2FA code`); return; }
    const plan = copyPlan(secondsLeft(Date.now()));
    if (plan.kind === "now") { void copyCodeNow(r); return; }
    setMsg(null);
    setWaitingRel(r.rel);
    setNote(waitingMessage(plan.seconds));
    const g = gen.current;
    timers.current.push(setTimeout(() => {
      if (g !== gen.current) return;
      setWaitingRel(null);
      void copyCodeNow(r);
    }, msUntilNextStep(Date.now()) + 250));
  };

  const open = (r: QuickResult) => { close(false); void showMain("open", r.rel); };

  // Esc works whatever has the focus (the search box is disabled while locked).
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); close(true); } };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [close]);

  const unlock = () => { setVisible(false); void showMain("unlock"); };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (phase !== "ready") return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => moveSelection(s, e.key === "ArrowDown" ? 1 : -1, results.length));
      return;
    }
    // A focused row button (the 2FA code) handles Enter / Space itself.
    if (e.key === "Enter" && (e.target as HTMLElement).closest("button")) return;
    if (e.key === "Enter" && e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && current) {
      e.preventDefault();
      copyCode(current);
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

  const mainLabel = current?.kind === "login" || current?.kind === "ssh" || current?.kind === "wifi" ? "password"
    : current?.kind === "secret" ? "key"
    : current?.kind === "card" ? "card number"
    : current?.kind === "codes" ? "next code" : "open";
  const secondaryLabel = current?.kind === "secret" ? "env name" : current?.kind === "wifi" ? "network name"
    : current?.kind === "card" ? "cardholder" : "username";

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
        {phase === "loading" && <InlineLoading label="Loading…" className="p-4" />}

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
                {r.totp && r.kind === "login" && (
                  <CodeButton
                    name={r.name}
                    code={codes[r.rel]?.step === step ? codes[r.rel].code : ""}
                    left={secondsLeft(now)}
                    waiting={waitingRel === r.rel}
                    onCopy={() => { setSel(i); copyCode(r); }}
                  />
                )}
              </li>
            ))}
          </ul>
        )}

        {phase === "error" && <p className="p-4 text-xs text-[var(--color-danger)]">{msg}</p>}
      </div>

      <div className="px-3 py-1.5 border-t border-[var(--color-border)] text-[11px] text-[var(--color-text-muted)] flex items-center gap-3">
        {msg && phase === "ready" ? (
          <span role="alert" className="text-[var(--color-danger)] truncate">{msg}</span>
        ) : note && phase === "ready" ? (
          <span role="status" className="text-[var(--color-success)] truncate">{note}</span>
        ) : phase === "ready" ? (
          <>
            <span className="whitespace-nowrap"><kbd>↵</kbd> {mainLabel === "open" ? "open" : `copy ${mainLabel}`}</span>
            <span className="whitespace-nowrap"><kbd>Ctrl+↵</kbd> copy {secondaryLabel}</span>
            {current?.totp && <span className="whitespace-nowrap"><kbd>Shift+↵</kbd> copy 2FA code</span>}
            <span className="whitespace-nowrap"><kbd>Alt+↵</kbd> {current?.totp ? "open" : "open in Notiq"}</span>
            <span className="ml-auto whitespace-nowrap"><kbd>Esc</kbd> close</span>
          </>
        ) : (
          <span className="ml-auto"><kbd>Esc</kbd> close</span>
        )}
      </div>
      {ctxMenu}
    </div>
  );
}

/**
 * A row's live 2FA code + countdown ring; click (or Enter / Space when focused) copies it.
 * Screen readers: the name says whose code it is and the seconds left *when it got the focus*
 * (`aria-live="off"`, the label isn't updated every tick), so nothing is announced each second.
 */
function CodeButton({ name, code, left, waiting, onCopy }: {
  name: string; code: string; left: number; waiting: boolean; onCopy: () => void;
}) {
  const [label, setLabel] = useState(() => codeLabel(name, left));
  const low = left < NEAR_EXPIRY_SECONDS;
  return (
    <button
      type="button"
      aria-label={label}
      aria-live="off"
      title="Copy 2FA code (Shift+Enter)"
      className="shrink-0 flex items-center gap-1.5 px-2 py-1 rounded-md border border-[var(--color-border)] text-xs hover:bg-[var(--color-bg-secondary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-primary)]"
      onFocus={() => setLabel(codeLabel(name, left))}
      onMouseDown={(e) => e.preventDefault() /* keep the focus in the search box */}
      onClick={(e) => { e.stopPropagation(); onCopy(); }}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <TotpRing left={left} period={TOTP_PERIOD} low={low} />
      <span aria-hidden className={`font-mono tabular-nums tracking-wide ${low ? "text-[var(--color-text-muted)]" : ""}`}>
        {code ? formatCode(code) : "••• •••"}
      </span>
      {waiting
        ? <Hourglass size={12} aria-hidden className="text-[var(--color-text-muted)]" />
        : <Copy size={12} aria-hidden className="text-[var(--color-text-muted)]" />}
    </button>
  );
}
