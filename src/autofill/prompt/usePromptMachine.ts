import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { applyTheme } from "../../lib/themes";
import { ERR_LOCKED, vaultStatus } from "../../lib/vault";
import {
  cardReply, clearTrust, fillReply, isFallbackRequest, isTrusted, saveLogin, scanCards, scanLogins, setVaultRootResolver,
  trustHost, validIntent, type SaveRequest,
} from "../../lib/autofill";
import { identityReply, scanIdentities, validAccount } from "../../lib/autofill";
import { answerList, answerSaveCheck, answerUsernameCopy, copyForExtension, validCopyWhat } from "../../lib/autofillPopup";
import {
  hasExcludedPasskey, passkeyReply, savePasskey, scanPasskeys, toCreateReq, toGetReq,
} from "../../lib/passkeys";
import { fitWindowSize, sizeChanged } from "../fitWindowSize";
import {
  dropFromQueue, enqueue, IDLE, step, type Effect, type FillReq, type Job, type PromptEvent, type PromptState,
} from "../promptMachine";
import { LABEL, nextTask, popupDeps, promptVaultRoot, reply, type ThemeId } from "./promptHost";

/**
 * The approval window's request queue and state machine: listens for the extension's requests, runs the machine's
 * effects (scans, replies, showing / hiding and sizing the window), and returns the current state.
 */
export function usePromptMachine() {
  const [state, setState] = useState<PromptState>(IDLE);
  const stateRef = useRef<PromptState>(IDLE);
  const queue = useRef<Job[]>([]);
  /** A request is being processed (from start until `finish`). */
  const active = useRef(false);
  /** The window is on screen (so hiding it should hand the focus back). */
  const shown = useRef(false);
  const fx = useRef<Promise<void>>(Promise.resolve());
  const sized = useRef<{ width: number; height: number } | null>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const footRef = useRef<HTMLDivElement>(null);
  /** The row whose read-only details view is open, for request `id` only (nothing secret is kept here). */
  const [details, setDetails] = useState<{ id: string; index: number } | null>(null);

  // ── window size ───────────────────────────────────────────────────────────
  const measure = useCallback(() => {
    const h = (headRef.current?.offsetHeight ?? 0) + (contentRef.current?.offsetHeight ?? 0)
      + (footRef.current?.offsetHeight ?? 0) + 2; // the window's 1px border, top and bottom
    return fitWindowSize(document.documentElement.clientWidth, h);
  }, []);

  const applySize = useCallback(async (recenter: boolean) => {
    const next = measure();
    if (!sizeChanged(sized.current, next)) return;
    sized.current = next;
    const w = getCurrentWindow();
    await w.setSize(new LogicalSize(next.width, next.height)).catch(() => {});
    if (recenter) await w.center().catch(() => {});
  }, [measure]);

  // ── state machine plumbing ────────────────────────────────────────────────
  // `dispatch` is assigned below; effects call back into it.
  const dispatchRef = useRef<(ev: PromptEvent) => void>(() => {});

  const startNext = useCallback(() => {
    const job = queue.current.shift();
    if (job) void startJob(job);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runEffect = useCallback(async (e: Effect) => {
    const dispatch = dispatchRef.current;
    switch (e.kind) {
      case "reply":
        await reply(e.id, e.payload);
        return;
      case "show":
        // Size to the new content before the window appears, then let Rust centre and focus it.
        await nextTask();
        await applySize(false);
        // The request ended while the window was being sized (cancelled, timed out): nothing to show.
        if (stateRef.current.stage === "idle") return;
        shown.current = true;
        await invoke("autofill_prompt_show").catch(() => {});
        // Tell Rust a frame really was painted: a window that is on screen but never says so is blank, and Rust repaints it.
        requestAnimationFrame(() => requestAnimationFrame(() => { void invoke("autofill_prompt_painted").catch(() => {}); }));
        requestAnimationFrame(() => {
          const a = document.activeElement;
          if (!a || a === document.body) {
            document.querySelector<HTMLElement>("[data-autofocus], [data-dialog-cancel], [data-dialog-default]")?.focus();
          }
        });
        return;
      case "finish":
        if (shown.current) {
          shown.current = false;
          await invoke("autofill_prompt_hide", { restore: true }).catch(() => {});
        }
        active.current = false;
        startNext();
        return;
      case "scan":
        try {
          const { matches, lookalike } = await scanLogins(e.host);
          dispatch({ type: "scanned", matches, lookalike });
        } catch (err) {
          dispatch(err === ERR_LOCKED ? { type: "vaultLocked" } : { type: "failed" });
        }
        return;
      case "scanCards":
        try {
          dispatch({ type: "cardsScanned", cards: await scanCards() });
        } catch (err) {
          dispatch(err === ERR_LOCKED ? { type: "vaultLocked" } : { type: "failed" });
        }
        return;
      case "releaseCard":
        await reply(e.id, cardReply(e.card));
        dispatch({ type: "answered" });
        return;
      case "scanIdentities":
        try {
          dispatch({ type: "identitiesScanned", identities: await scanIdentities() });
        } catch (err) {
          dispatch(err === ERR_LOCKED ? { type: "vaultLocked" } : { type: "failed" });
        }
        return;
      case "releaseIdentity":
        await reply(e.id, identityReply(e.identity));
        dispatch({ type: "answered" });
        return;
      case "release":
        try {
          if (e.trustHost) {
            const until = trustHost(e.trustHost);
            // The trust lives in this page: the hidden window must not be closed while it lasts.
            void Promise.resolve(invoke("autofill_prompt_keep", { ms: until - Date.now() + 1000 })).catch(() => {});
          }
          await reply(e.id, e.copy ? await copyForExtension(e.match, e.copy) : await fillReply(e.match, e.intent));
        } catch {
          await reply(e.id, { error: "failed" });
        }
        dispatch({ type: "answered" });
        return;
      // ── passkeys (experimental): Rust makes the key and signs; this window asks and stores ──
      case "scanPasskeyTargets":
        try {
          const [{ matches }, excluded] = await Promise.all([scanLogins(e.host), hasExcludedPasskey(e.rpId, e.exclude)]);
          dispatch({ type: "passkeyTargetsScanned", logins: matches, excluded });
        } catch (err) {
          dispatch(err === ERR_LOCKED ? { type: "vaultLocked" } : { type: "failed" });
        }
        return;
      case "scanPasskeys":
        try {
          dispatch({ type: "passkeysScanned", passkeys: await scanPasskeys(e.rpId, e.allow) });
        } catch (err) {
          dispatch(err === ERR_LOCKED ? { type: "vaultLocked" } : { type: "failed" });
        }
        return;
      case "savePasskey":
        try {
          await savePasskey(e.target, e.req);
          await reply(e.id, { ok: true });
          await emitTo("main", "vault:entries-changed", {}).catch(() => {});
        } catch {
          await reply(e.id, { error: "failed" });
        }
        dispatch({ type: "answered" });
        return;
      case "releasePasskey":
        await reply(e.id, passkeyReply(e.match));
        dispatch({ type: "answered" });
        return;
      case "save":
        try {
          const status = await saveLogin(e.plan, e.req, e.name, { refreshTabs: false });
          await reply(e.id, { ok: true, status });
          // The main window refreshes its vault tree and open tabs.
          await emitTo("main", "vault:entries-changed", {}).catch(() => {});
        } catch {
          await reply(e.id, { error: "failed" });
        }
        dispatch({ type: "answered" });
        return;
    }
  }, [applySize, startNext]);

  const dispatch = useCallback((ev: PromptEvent) => {
    const { state: next, effects } = step(stateRef.current, ev);
    if (next !== stateRef.current) {
      stateRef.current = next;
      flushSync(() => setState(next));
    }
    for (const e of effects) fx.current = fx.current.then(() => runEffect(e)).catch(() => {});
  }, [runEffect]);
  dispatchRef.current = dispatch;

  async function startJob(job: Job) {
    active.current = true;
    let exists = true;
    let unlocked = false;
    try {
      await promptVaultRoot();
      ({ exists, unlocked } = await vaultStatus());
    } catch { /* treat as locked: the user can still unlock here */ }
    const trusted = unlocked && job.kind === "fill" && isTrusted(job.req.host);
    dispatchRef.current({ type: "start", job, exists, unlocked, trusted });
  }

  const accept = useCallback((job: Job) => {
    if (!active.current) { void startJob(job); return; }
    const r = enqueue(queue.current, job);
    queue.current = r.queue;
    if (r.rejected) void reply(r.rejected.req.id, { error: "denied" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── setup: theme, listeners, ready signal ─────────────────────────────────
  useEffect(() => {
    document.documentElement.classList.add("is-autofill-prompt");
    applyTheme((localStorage.getItem("pref:theme") || "dark") as ThemeId);
    setVaultRootResolver(promptVaultRoot);

    let cancelled = false;
    const subs = [
      listen<{ themeId: string }>("theme-changed", (e) => applyTheme(e.payload.themeId as ThemeId)),
      // A global `listen` also hears events Rust sent to the main window; those (fallback) are not ours.
      listen<Omit<FillReq, "intent"> & { intent?: unknown; fallback?: boolean }>("autofill:request", (e) => {
        if (isFallbackRequest(e.payload)) return;
        const { id, host, account } = e.payload;
        const intent = validIntent(e.payload.intent);
        accept({ kind: "fill", req: { id, host, ...(account ? { account } : {}), ...(intent ? { intent } : {}) } });
      }),
      listen<SaveRequest & { fallback?: boolean }>("autofill:save", (e) => {
        if (isFallbackRequest(e.payload)) return;
        const { id, host, url, username, password, title, current } = e.payload;
        accept({ kind: "save", req: { id, host, url, username, password, title, ...(typeof current === "string" && current ? { current } : {}) } });
      }),
      // Should the page offer Save, Update or nothing? Answered silently (no window, no unlock offer).
      listen<{ id: string; host: string; username: string; password: string; current?: unknown }>("autofill:save-check", (e) => {
        const { id, host, username, password, current } = e.payload;
        const req = { host, username, password, ...(typeof current === "string" && current ? { current } : {}) };
        void answerSaveCheck(popupDeps, req).then((r) => reply(id, r));
      }),
      // Card requests come only to this window (Rust has no main-window fallback for them).
      listen<{ id: string; host: string }>("autofill:card", (e) => {
        const { id, host } = e.payload;
        accept({ kind: "card", req: { id, host } });
      }),
      // Identity requests too (prompt window only; `account` only pre-selects the identity).
      listen<{ id: string; host: string; account?: unknown }>("autofill:identity", (e) => {
        const { id, host } = e.payload;
        const account = validAccount(e.payload.account);
        accept({ kind: "identity", req: { id, host, ...(account ? { account } : {}) } });
      }),
      // The toolbar popup (0.9.0). `list` and a username copy are answered silently; a password / code copy is
      // a fill job (same approval: prompt or the site's trust window) whose release copies instead of replying.
      // The popup's Unlock button: show the unlock form here; the machine answers once the vault is open.
      listen<{ id: string }>("autofill:unlock", (e) => {
        if (typeof e.payload?.id === "string") accept({ kind: "unlock", req: { id: e.payload.id } });
      }),
      listen<{ id: string; host: string }>("autofill:list", (e) => {
        const { id, host } = e.payload;
        void answerList(popupDeps, host).then((r) => reply(id, r));
      }),
      listen<{ id: string; host: string; account: string; what: unknown }>("autofill:copy", (e) => {
        const { id, host, account } = e.payload;
        const what = validCopyWhat(e.payload.what);
        if (!what || !account) { void reply(id, { error: "bad_request" }); return; }
        if (what === "username") { void answerUsernameCopy(popupDeps, host, account).then((r) => reply(id, r)); return; }
        accept({ kind: "fill", req: { id, host, account, copy: what, ...(what === "code" ? { intent: "code" as const } : {}) } });
      }),
      // Passkeys (experimental): prompt window only, always asked (Rust never routes them to the main window).
      listen<Record<string, unknown>>("autofill:passkey-create", (e) => {
        const req = toCreateReq(e.payload);
        if (!req) { if (typeof e.payload.id === "string") void reply(e.payload.id, { error: "bad_request" }); return; }
        accept({ kind: "passkeyCreate", req });
      }),
      listen<Record<string, unknown>>("autofill:passkey-get", (e) => {
        const req = toGetReq(e.payload);
        if (!req) { if (typeof e.payload.id === "string") void reply(e.payload.id, { error: "bad_request" }); return; }
        accept({ kind: "passkeyGet", req });
      }),
      listen<{ id: string }>("autofill:cancel", (e) => {
        queue.current = dropFromQueue(queue.current, e.payload.id);
        dispatch({ type: "cancel", id: e.payload.id });
      }),
      listen("autofill-prompt:dismiss", () => dispatch({ type: "deny" })),
      listen<{ unlocked: boolean; source?: string }>("vault:state-changed", (e) => {
        if (!e.payload.unlocked) {
          clearTrust();
          setDetails(null); // drop the details view (and everything it read) at once, not only with the request
          dispatch({ type: "vaultLocked" });
        } else if (e.payload.source !== LABEL) {
          dispatch({ type: "unlocked" }); // unlocked in the main window while this one asked for the password
        }
      }),
      // Closing the main window to the tray ends every trust window (as before).
      listen("vault-window-hidden", () => clearTrust()),
    ];
    // Ready only once every listener is registered.
    void Promise.all(subs).then(() => { if (!cancelled) void invoke("autofill_ui_ready").catch(() => {}); });
    return () => {
      cancelled = true;
      subs.forEach((p) => p.then((un) => un()).catch(() => {}));
    };
  }, [accept, dispatch]);

  // Follow content changes while on screen (an error line, a longer list).
  useEffect(() => {
    const ro = new ResizeObserver(() => { if (shown.current) void applySize(true); });
    [headRef, contentRef, footRef].forEach((r) => { if (r.current) ro.observe(r.current); });
    return () => ro.disconnect();
  }, [state, applySize]);

  return { state, dispatch, shown, refs: { headRef, contentRef, footRef }, details, setDetails };
}
