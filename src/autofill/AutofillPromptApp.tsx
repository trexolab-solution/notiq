import { useCallback, useEffect, useRef, useState } from "react";
import { useWindowContextMenu } from "../hooks/useWindowContextMenu";
import type { FormEvent, KeyboardEvent, ReactNode, RefObject } from "react";
import { flushSync } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { Copy, CreditCard, FingerprintPattern, Globe, IdCard, KeyRound, Lock, ShieldCheck, Timer, TriangleAlert } from "lucide-react";
import { DialogButton } from "../components/ui/DialogParts";
import { SaveFields } from "../components/vault/autofillBodies";
import {
  cardAllowLabel, cardChoiceItems, fillAllowLabel, identityAllowLabel, identityChoiceItems, loginChoiceItems, SheetPicker,
  type ChoiceItem,
} from "../components/vault/autofillChoices";
import { Avatar } from "../components/ui/Avatar";
import { InlineLoading } from "../components/ui/Loading";
import { useVaultUnlock } from "../components/vault/unlock/useVaultUnlock";
import { VaultUnlockBody } from "../components/vault/unlock/VaultUnlockForm";
import { useDialogBehaviour } from "../components/ui/useDialogBehaviour";
import type { DefaultFocus } from "../components/ui/dialogLogic";
import { applyTheme } from "../lib/themes";
import { resolveVaultDir } from "../lib/vaultDir";
import { ERR_LOCKED, vaultStatus } from "../lib/vault";
import { nameError } from "../lib/vaultTree";
import { LOOKALIKE_REASON_TEXT } from "../lib/lookalike";
import {
  cardReply, clearTrust, fillReply, hasSaveChoice, isFallbackRequest, isTrusted, loginLastUsed, saveLogin, scanCards, scanLogins,
  setVaultRootResolver, trustHost, validIntent, type LoginMatch, type SaveRequest,
} from "../lib/autofill";
import { identityReply, scanIdentities, validAccount } from "../lib/autofill";
import { answerList, answerSaveCheck, answerUsernameCopy, copyForExtension, COPY_LABEL, validCopyWhat, type PopupDeps } from "../lib/autofillPopup";
import {
  hasExcludedPasskey, passkeyReply, savePasskey, scanPasskeys, toCreateReq, toGetReq,
} from "../lib/passkeys";
import { PasskeyChoice, PasskeyTargetChoice } from "./PasskeyChoices";
import { EntryDetailsView } from "./EntryDetailsView";
import { fitWindowSize, sizeChanged } from "./fitWindowSize";
import { splitHost } from "./hostParts";
import { canFillAndCopyCode, loginActionLabel, loginMeta, loginTitle, looseMatchOf } from "./sheetCopy";
import {
  dropFromQueue, enqueue, IDLE, step, type Effect, type FillReq, type Job, type PromptEvent, type PromptState,
} from "./promptMachine";

/**
 * The browser-autofill approval window (label `autofill-prompt`, route `#/autofill-prompt`).
 *
 * Rust routes every `autofill:request` / `autofill:save` here and never raises the main window.
 * This window stays hidden unless it needs the user: a trusted site, no match or an unchanged save
 * is answered silently. Otherwise it sizes itself to its content, asks Rust to show it (centred,
 * always on top, focused), and after the answer hides again and hands the focus back to the browser.
 * The window lives for the whole session (hidden) so the 5-minute trust windows survive.
 */

const LABEL = "autofill-prompt";
type ThemeId = Parameters<typeof applyTheme>[0];

const reply = (id: string, payload: unknown) => invoke("autofill_reply", { id, payload }).catch(() => {});

/** No file-system access here: just tell the backend where the vault folder is. */
async function promptVaultRoot(): Promise<string> {
  const root = await resolveVaultDir();
  await invoke("vault_set_root", { root });
  return root;
}

const nextTask = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * The native window's own background follows the theme's sheet colour, so the strip a resize uncovers
 * (the list opening, an error line) never flashes the dark default of a light theme before the page repaints.
 */
function syncWindowBackground() {
  requestAnimationFrame(() => {
    const rgb = getComputedStyle(document.body).backgroundColor.match(/\d+(\.\d+)?/g)?.map(Number);
    if (!rgb || rgb.length < 3 || (rgb.length > 3 && rgb[3] === 0)) return;
    void getCurrentWindow().setBackgroundColor([rgb[0], rgb[1], rgb[2], 255]).catch(() => {});
  });
}

/** The toolbar popup's silent requests (list, username copy): no window, no unlock offer. */
const popupDeps: PopupDeps = {
  prepare: promptVaultRoot,
  unlocked: async () => (await vaultStatus()).unlocked,
  scan: async (host) => (await scanLogins(host)).matches,
  lockedError: ERR_LOCKED,
};

export default function AutofillPromptApp() {
  // No text menu here (copies go through the details view's copy buttons): just keep the webview's menu out.
  useWindowContextMenu({ textMenu: false });
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
  /** The chooser's search text, for request `id` only (a new request starts with an empty search). */
  const [query, setQuery] = useState<{ id: string; q: string }>({ id: "", q: "" });

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
        shown.current = true;
        await invoke("autofill_prompt_show").catch(() => {});
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
          if (e.trustHost) trustHost(e.trustHost);
          await reply(e.id, e.copy ? await copyForExtension(e.match, e.copy) : await fillReply(e.match, e.intent));
          // Shift+Enter on Fill: the 2-step code also goes to the clipboard (wiped after the usual delay).
          if (e.copyCode && !e.copy) await copyForExtension(e.match, "code").catch(() => {});
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
    syncWindowBackground();
    setVaultRootResolver(promptVaultRoot);

    let cancelled = false;
    const subs = [
      listen<{ themeId: string }>("theme-changed", (e) => { applyTheme(e.payload.themeId as ThemeId); syncWindowBackground(); }),
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

  if (state.stage === "idle" || (state.stage === "checking" && state.silent)) {
    // Nothing to show (the window is hidden, or about to be).
    return <div className="af-window" aria-hidden />;
  }

  const refs = { headRef, contentRef, footRef };
  const deny = () => dispatch({ type: "deny" });

  // ── details sub-view (logins, cards, identities) ──────────────────────────
  const reqId = "job" in state ? state.job.req.id : null;
  const viewing = details && details.id === reqId ? details.index : null;
  const openDetails = (index: number) => { if (reqId) setDetails({ id: reqId, index }); };
  const closeDetails = () => {
    const index = viewing;
    setDetails(null);
    // Back on the sheet: put the focus on the selected entry's details button again.
    if (index !== null) requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-af-details="${index}"]`)?.focus());
  };
  /** "Open in Notiq": the main window opens the entry; this request ends as denied (nothing is filled). */
  const openInNotiq = async (rel: string) => {
    const wasShown = shown.current;
    shown.current = false; // Rust hides the window itself, handing the focus to the main window, not the browser
    try {
      await invoke("autofill_prompt_open_entry", { rel });
    } catch {
      shown.current = wasShown;
      return;
    }
    setDetails(null);
    dispatch({ type: "deny" });
  };
  // ── chooser stages (logins, cards, identities) ────────────────────────────
  const q = query.id === reqId ? query.q : "";
  const onQuery = (value: string) => { if (reqId) setQuery({ id: reqId, q: value }); };
  const onPick = (index: number) => dispatch({ type: "pick", index });
  /** Double-click on an option and "Fill this login" in the details view: the same as picking the row, then Fill. */
  const pickAndAllow = (index: number) => { dispatch({ type: "pick", index }); dispatch({ type: "allow" }); };
  /** After choosing in the list, the focus goes to Fill (a second, deliberate Enter fills). */
  const focusFill = () => document.querySelector<HTMLElement>("[data-af-fill]:not(:disabled)")?.focus();

  const chooser = (o: {
    key: string; host: string; kind: Kind; title: string; items: ChoiceItem[]; pick: number; noun: string; label: string;
    entries: { path: string; rel?: string }[]; busy: boolean; actionLabel: string; actionAria: string; busyText: string;
    fillLabel: string; secure?: boolean; risk?: ReactNode; note?: ReactNode; trust?: { on: boolean; set: (on: boolean) => void };
    copyCode?: boolean; summaryOf?: (item: ChoiceItem) => { title: ReactNode; sub: ReactNode };
  }) => {
    const at = viewing;
    const viewed = at !== null ? o.entries[at] : undefined;
    return (
      <Sheet key={o.key} refs={refs} host={o.host} title={o.title} kind={o.kind} secure={o.secure} avatar="site"
             compact={!!viewed} risk={!viewed && !!o.risk}
             onClose={deny} onEscape={viewed ? closeDetails : undefined} defaultFocus="cancel"
             footer={viewed ? null : (
               <SheetActions>
                 <DialogButton variant="primary" className="af-pill" data-af-fill="" data-af-nav="" icon={<KeyRound size={17} />}
                               aria-label={o.actionAria} title={o.actionAria} loading={o.busy} loadingText={o.busyText}
                               onClick={() => dispatch({ type: "allow" })}
                               onKeyDown={(e) => {
                                 // Shift+Enter: fill and also copy the 2-step code (only offered when the login has one).
                                 if (e.key === "Enter" && e.shiftKey && o.copyCode) { e.preventDefault(); dispatch({ type: "allow", copyCode: true }); }
                               }}>
                   {o.actionLabel}
                 </DialogButton>
                 <DialogButton cancel variant="ghost" className="af-pill af-pill--quiet" data-af-nav="" onClick={deny} disabled={o.busy}>
                   Not now
                 </DialogButton>
                 {o.trust && (
                   <label className="af-trust" title="Only this exact site, and only while the vault stays unlocked.">
                     <input type="checkbox" data-af-nav="" checked={o.trust.on} disabled={o.busy}
                            onChange={(e) => o.trust!.set(e.target.checked)} />
                     <span>Don&rsquo;t ask again on this site for 5 minutes</span>
                   </label>
                 )}
                 <KeyHints copyCode={o.copyCode} />
               </SheetActions>
             )}>
        {viewed && at !== null ? (
          <EntryDetailsView key={viewed.path} path={viewed.path} title={o.items[at]?.title} onBack={closeDetails} busy={o.busy}
                            fillLabel={o.fillLabel} onFill={() => pickAndAllow(at)}
                            onOpen={viewed.rel ? () => void openInNotiq(viewed.rel!) : undefined} />
        ) : <>
          {o.risk}
          <SheetPicker label={o.label} noun={o.noun} items={o.items} pick={o.pick}
                       onPick={onPick} onAllow={pickAndAllow} onDetails={openDetails} disabled={o.busy}
                       query={q} onQuery={onQuery} summaryOf={o.summaryOf} onChosen={focusFill} />
          {o.note}
        </>}
      </Sheet>
    );
  };

  switch (state.stage) {
    case "checking":
      // Only seen right after an unlock in this window, while the vault is read (usually a blink).
      return (
        <Sheet key={`checking-${state.job.req.id}`} refs={refs} host={state.job.req.host} avatar={<ShieldCheck size={26} />}
               title="Vault unlocked" onClose={deny}
               footer={<SheetActions><DialogButton cancel variant="ghost" className="af-pill af-pill--quiet" onClick={deny}>Cancel</DialogButton></SheetActions>}>
          <InlineLoading delay={0} className="af-state"
                         label={state.job.kind === "card" ? "Looking for saved cards…"
                           : state.job.kind === "identity" ? "Looking for saved identities…"
                           : state.job.kind === "passkeyGet" ? "Looking for saved passkeys…" : "Looking for saved logins for this site…"} />
        </Sheet>
      );
    case "locked":
      return <LockedStage key={`locked-${state.job.req.id}`} refs={refs} job={state.job} dispatch={dispatch} onDeny={deny} />;
    case "request": {
      const { job, matches, pick, trust, busy } = state;
      const { copy, intent } = job.req;
      const m = matches[pick];
      const { site } = splitHost(job.req.host);
      const name = (m?.entry.title || "").trim() || site;
      const loose = m ? looseMatchOf(job.req.host, m.entry) : null;
      const byPath = new Map(matches.map((x) => [x.path, x] as const));
      return chooser({
        key: `request-${job.req.id}`, host: job.req.host, busy, pick, entries: matches, items: loginChoiceItems(matches),
        noun: "logins", label: "Saved logins",
        kind: copy ? { icon: <Copy size={12} />, label: `Copy ${COPY_LABEL[copy]}` }
          : intent === "code" ? { icon: <Timer size={12} />, label: "2-step code" } : { icon: <KeyRound size={12} />, label: "Login" },
        title: loginTitle(name, job.req), secure: !!m && !loose,
        risk: loose ? (
          <RiskBanner>
            This login is saved for <strong className="af-host-inline">{loose}</strong>, not exactly this address.
            Only continue if <strong className="af-host-inline">{job.req.host}</strong> is the site you expect.
          </RiskBanner>
        ) : null,
        actionLabel: loginActionLabel(job.req), actionAria: fillAllowLabel(m, job.req), busyText: copy ? "Copying…" : "Filling…",
        fillLabel: copy ? `Copy the ${COPY_LABEL[copy]}` : intent === "code" ? "Fill this code" : "Fill this login",
        trust: copy ? undefined : { on: trust, set: (on) => dispatch({ type: "trust", on }) },
        copyCode: canFillAndCopyCode(m, job.req),
        summaryOf: (item) => {
          const x: LoginMatch | undefined = byPath.get(item.key);
          if (!x) return { title: item.title, sub: item.sub };
          const user = x.entry.username.trim();
          return {
            title: user || item.title,
            sub: loginMeta(x, loginLastUsed(x)) || (user ? item.title : item.sub),
          };
        },
      });
    }
    case "card": {
      const { job, cards, pick, busy } = state;
      const { site } = splitHost(job.req.host);
      return chooser({
        key: `card-${job.req.id}`, host: job.req.host, busy, pick, entries: cards, items: cardChoiceItems(cards),
        noun: "cards", label: "Saved cards",
        kind: { icon: <CreditCard size={12} />, label: "Payment card" }, title: `Fill card on ${site}?`,
        note: <p className="af-note-line">The card number, expiry and security code go to this page.</p>,
        actionLabel: "Fill card", actionAria: cardAllowLabel(cards[pick]), busyText: "Filling…", fillLabel: "Fill this card",
      });
    }
    case "identity": {
      const { job, identities, pick, busy } = state;
      const { site } = splitHost(job.req.host);
      return chooser({
        key: `identity-${job.req.id}`, host: job.req.host, busy, pick, entries: identities, items: identityChoiceItems(identities),
        noun: "identities", label: "Saved identities",
        kind: { icon: <IdCard size={12} />, label: "Identity" }, title: `Fill your details on ${site}?`,
        note: <p className="af-note-line">Your name, email, phone and address go to this page.</p>,
        actionLabel: "Fill details", actionAria: identityAllowLabel(identities[pick]), busyText: "Filling…", fillLabel: "Fill with this identity",
      });
    }
    case "save": {
      const { job, plan, name, reveal, busy } = state;
      const update = plan.kind === "update";
      const nameErr = update ? null : nameError(name);
      const confirm = () => dispatch({ type: "confirmSave", nameOk: !nameErr });
      const choice = hasSaveChoice(plan);
      const { site } = splitHost(job.req.host);
      return (
        <Sheet key={`save-${job.req.id}`} refs={refs} host={job.req.host} avatar="site"
               kind={{ icon: <KeyRound size={12} />, label: update ? "Update login" : "New login" }}
               title={update ? `Update password for ${site}?` : `Save login for ${site}?`}
               onClose={deny}
               footer={
                 <SheetActions>
                   <DialogButton variant="primary" className="af-pill" disabled={!!nameErr} loading={busy}
                                 loadingText={update ? "Updating…" : "Saving…"} onClick={confirm}>{update ? "Update" : "Save"}</DialogButton>
                   {update && choice && (
                     <DialogButton className="af-pill af-pill--outline" disabled={busy} onClick={() => dispatch({ type: "saveAsNew", on: true })}>
                       Save as new
                     </DialogButton>
                   )}
                   <DialogButton cancel variant="ghost" className="af-pill af-pill--quiet" onClick={deny} disabled={busy}>Not now</DialogButton>
                 </SheetActions>
               }>
          <p className="af-note-line">Only save it if you just signed in on this site.</p>
          <SaveFields req={job.req} plan={plan} name={name} nameError={nameErr} reveal={reveal} disabled={busy}
                      onName={(value) => dispatch({ type: "name", value })} onReveal={() => dispatch({ type: "reveal" })}
                      onTarget={(index) => dispatch({ type: "saveTarget", index })}
                      onSaveAsNew={(on) => dispatch({ type: "saveAsNew", on })}
                      onEnter={confirm} />
        </Sheet>
      );
    }
    case "passkeyCreate": {
      const { job, logins, pick, excluded, busy } = state;
      const who = job.req.userName || job.req.displayName;
      const kind = { icon: <FingerprintPattern size={12} />, label: "Passkey" };
      if (excluded) {
        return (
          <Sheet key={`passkey-create-${job.req.id}`} refs={refs} host={job.req.host} avatar={<FingerprintPattern size={26} />}
                 kind={kind} title="Passkey already saved" onClose={deny} defaultFocus="cancel"
                 footer={
                   <SheetActions>
                     <DialogButton variant="primary" className="af-pill" onClick={() => dispatch({ type: "allow" })}>OK</DialogButton>
                     <DialogButton cancel variant="ghost" className="af-pill af-pill--quiet" onClick={deny}>Cancel</DialogButton>
                   </SheetActions>
                 }>
            <p className="af-note-line">
              Notiq already has a passkey for {who ? <strong>{who}</strong> : "this account"} on {job.req.rpId}. Nothing new
              is saved. Press OK to tell the site, or Cancel to use another passkey from your browser instead.
            </p>
          </Sheet>
        );
      }
      return (
        <Sheet key={`passkey-create-${job.req.id}`} refs={refs} host={job.req.host} avatar={<FingerprintPattern size={26} />}
               kind={kind} title={`Save a passkey for ${job.req.rpId}?`} onClose={deny} defaultFocus="cancel"
               footer={
                 <SheetActions>
                   <DialogButton variant="primary" className="af-pill" loading={busy} loadingText="Saving…"
                                 onClick={() => dispatch({ type: "allow" })}>Save passkey</DialogButton>
                   <DialogButton cancel variant="ghost" className="af-pill af-pill--quiet" onClick={deny} disabled={busy}>Not now</DialogButton>
                 </SheetActions>
               }>
          <p className="af-note-line">
            Save a new passkey{who ? <> for <strong>{who}</strong></> : null} in your vault (experimental). Only save it if you
            just chose to create a passkey on this site.
          </p>
          <PasskeyTargetChoice logins={logins} pick={pick} disabled={busy} onPick={(index) => dispatch({ type: "pick", index })} />
        </Sheet>
      );
    }
    case "passkeyGet": {
      const { job, passkeys, pick, busy } = state;
      return (
        <Sheet key={`passkey-get-${job.req.id}`} refs={refs} host={job.req.host} avatar={<FingerprintPattern size={26} />}
               kind={{ icon: <FingerprintPattern size={12} />, label: "Passkey" }}
               title={`Sign in to ${job.req.rpId} with a passkey?`} onClose={deny} defaultFocus="cancel"
               footer={
                 <SheetActions>
                   <DialogButton variant="primary" className="af-pill" loading={busy} loadingText="Signing in…"
                                 onClick={() => dispatch({ type: "allow" })}>Sign in</DialogButton>
                   <DialogButton cancel variant="ghost" className="af-pill af-pill--quiet" onClick={deny} disabled={busy}>Not now</DialogButton>
                 </SheetActions>
               }>
          <PasskeyChoice passkeys={passkeys} pick={pick} disabled={busy} onPick={onPick} onAllow={pickAndAllow} />
        </Sheet>
      );
    }
    case "warning":
      return (
        <Sheet key={`warning-${state.host}`} refs={refs} host={state.host} avatar={<TriangleAlert size={26} />} tone="danger"
               title="Notiq didn't fill this page" onClose={deny}
               footer={<SheetActions><DialogButton variant="primary" className="af-pill" onClick={deny}>OK</DialogButton></SheetActions>}>
          <div className="dlg-callout dlg-callout--danger" role="alert">
            <TriangleAlert size={14} className="shrink-0 mt-0.5" aria-hidden />
            <span>
              This may be a fake site: it looks like <strong>{state.lookalike.saved}</strong>, which you have a login for,
              but it {LOOKALIKE_REASON_TEXT[state.lookalike.reason]}.
            </span>
          </div>
          <p className="af-note-line">Nothing was sent to the page. Check the address before you type a password.</p>
        </Sheet>
      );
  }
}

// ── pieces ──────────────────────────────────────────────────────────────────

interface Refs {
  headRef: RefObject<HTMLDivElement>;
  contentRef: RefObject<HTMLDivElement>;
  footRef: RefObject<HTMLDivElement>;
}

/** What a request will fill, for the host line ("Login", "Payment card"…). */
interface Kind { icon: ReactNode; label: string }

interface SheetProps {
  refs: Refs;
  host: string;
  /** The question the sheet asks ("Sign in to GitHub?"). */
  title: string;
  /** "site": the site's letter avatar; otherwise an icon shown in the same tile. */
  avatar: "site" | ReactNode;
  kind?: Kind;
  /** The selected login is saved for exactly this host: the host line turns green with a shield. */
  secure?: boolean;
  /** A risk banner is in the body (`#af-risk`): read with the dialog's description. */
  risk?: boolean;
  /** Details sub-view: a slim header (the view has its own title row). */
  compact?: boolean;
  tone?: "primary" | "danger";
  onClose: () => void;
  /** Escape does this instead of `onClose` (e.g. back from a details view). */
  onEscape?: () => void;
  defaultFocus?: DefaultFocus;
  onSubmit?: (e: FormEvent<HTMLFormElement>) => void;
  /** null: no footer (the details view has its own actions). */
  footer: ReactNode | null;
  children: ReactNode;
}

const NAV = "[data-af-nav]:not(:disabled)";

/**
 * The whole window as one bottom-sheet dialog: grab handle (drag region), centred site tile, the question
 * as its title, the host line, a scrolling body and the stacked actions. Esc = deny (or back, see `onEscape`).
 * ↑ / ↓ move between the stacked controls marked `data-af-nav` (account row, Fill, Not now, the checkbox).
 */
function Sheet({
  refs, host, title, avatar, kind, secure, risk, compact, tone = "primary", onClose, onEscape, defaultFocus, onSubmit, footer, children,
}: SheetProps) {
  const panelRef = useRef<HTMLElement | null>(null);
  useDialogBehaviour(panelRef, { onClose: onEscape ?? onClose, dismissable: true, autoFocus: true, defaultFocus });
  const { prefix, site } = splitHost(host);
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if ((e.key !== "ArrowUp" && e.key !== "ArrowDown") || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    const t = e.target as HTMLElement;
    if (!t.matches?.("[data-af-nav]")) return;
    const all = Array.from(panelRef.current?.querySelectorAll<HTMLElement>(NAV) ?? []);
    const i = all.indexOf(t);
    const next = all[i + (e.key === "ArrowDown" ? 1 : -1)];
    if (i < 0 || !next) return;
    e.preventDefault();
    next.focus();
  };
  const inner = (
    <>
      <div ref={refs.headRef} className="af-head" data-compact={compact ? "" : undefined} data-tauri-drag-region>
        <div className="af-grab" aria-hidden data-tauri-drag-region />
        {!compact && (avatar === "site"
          ? <Avatar name={site} size={56} className="af-sheet-avatar" />
          : <span className="af-sheet-icon" data-tone={tone} aria-hidden>{avatar}</span>)}
        <h1 className="af-title" id="af-title">{title}</h1>
        <p className="af-hostline" id="af-desc" data-secure={secure ? "" : undefined} data-tauri-drag-region>
          {secure ? <ShieldCheck size={14} aria-hidden /> : <Globe size={14} aria-hidden />}
          <span className="af-host" title={host}>
            {prefix && <span className="af-host-prefix">{prefix}</span>}<span className="af-host-site">{site}</span>
          </span>
          {secure && <span className="sr-only">, saved for this exact site</span>}
          {kind && <span className="af-kind"><span aria-hidden className="af-dot">·</span>{kind.label}</span>}
        </p>
      </div>
      <div className="af-scroll">
        <div ref={refs.contentRef} className="af-content">{children}</div>
      </div>
      <div ref={refs.footRef}>{footer}</div>
    </>
  );
  const common = {
    ref: panelRef as never,
    className: "af-window af-sheet",
    role: "alertdialog" as const,
    "aria-modal": true,
    "aria-labelledby": "af-title",
    "aria-describedby": risk ? "af-desc af-risk" : "af-desc",
    tabIndex: -1,
    onKeyDown,
  };
  return onSubmit ? <form {...common} onSubmit={onSubmit}>{inner}</form> : <div {...common}>{inner}</div>;
}

/** Stacked actions: the primary pill, then the quieter ones, then small print. */
function SheetActions({ children }: { children: ReactNode }) {
  return <div className="af-actions">{children}</div>;
}

/** Shown only when the code can tell something is off (today: a login that matches this host only loosely). */
function RiskBanner({ children }: { children: ReactNode }) {
  return (
    <div className="af-risk" id="af-risk">
      <TriangleAlert size={15} aria-hidden />
      <span>{children}</span>
    </div>
  );
}

/** Keyboard hints. The focus starts on Not now, so a stray Enter never fills: ↑ reaches Fill first. */
function KeyHints({ copyCode }: { copyCode?: boolean }) {
  return (
    <p className="af-keys">
      <kbd>↑</kbd> <kbd>Enter</kbd> fill
      {copyCode && <> · <kbd>Shift</kbd>+<kbd>Enter</kbd> fill and copy 2FA</>}
      {" · "}<kbd>Esc</kbd> not now
    </p>
  );
}

interface LockedProps {
  refs: Refs;
  job: Job;
  dispatch: (ev: PromptEvent) => void;
  onDeny: () => void;
}

/** The vault is locked: the same unlock form as the main window (master password or Windows Hello). */
function LockedStage({ refs, job, dispatch, onDeny }: LockedProps) {
  const u = useVaultUnlock({
    onUnlocked: () => dispatch({ type: "unlocked" }),
    onStart: () => dispatch({ type: "unlockStarted" }),
    onFail: (error) => dispatch({ type: "unlockFailed", error }),
    // The Windows Hello dialog must not open underneath this always-on-top window.
    beforeHello: () => getCurrentWindow().setAlwaysOnTop(false).catch(() => {}),
    afterHello: async () => {
      const win = getCurrentWindow();
      await win.setAlwaysOnTop(true).catch(() => {});
      await win.setFocus().catch(() => {});
    },
  });
  const copy = job.kind === "fill" ? job.req.copy : undefined;
  const what = copy ? `copy the ${COPY_LABEL[copy]} of a saved login`
    : job.kind === "fill" ? (job.req.intent === "code" ? "fill a 2FA code" : "fill a saved login")
    : job.kind === "card" ? "fill a payment card" : job.kind === "identity" ? "fill your details (identity)"
    : job.kind === "passkeyCreate" ? `save a passkey for ${job.req.rpId}`
    : job.kind === "passkeyGet" ? `sign in to ${job.req.rpId} with a passkey` : "save a login";
  const submitLabel = copy ? "Unlock & copy" : job.kind === "fill" ? "Unlock & fill" : job.kind === "card" ? "Unlock & pick card"
    : job.kind === "identity" ? "Unlock & pick identity" : job.kind === "passkeyGet" ? "Unlock & continue"
    : job.kind === "passkeyCreate" ? "Unlock & continue" : "Unlock & save";
  const purpose = copy ? "unlock and copy it" : job.kind === "fill" ? "unlock and fill it" : job.kind === "card" ? "unlock and pick a card"
    : job.kind === "identity" ? "unlock and pick an identity" : job.kind === "passkeyGet" ? "unlock and pick a passkey"
    : job.kind === "passkeyCreate" ? "unlock and save the passkey" : "unlock and save it";
  return (
    <Sheet refs={refs} host={job.req.host} avatar={<Lock size={26} />} title="Unlock Notiq" onClose={onDeny} onSubmit={u.submit}
           footer={
             <SheetActions>
               {!u.showHello && (
                 <DialogButton type="submit" variant="primary" className="af-pill" loading={u.busy} loadingText="Unlocking…">
                   {submitLabel}
                 </DialogButton>
               )}
               <DialogButton cancel variant="ghost" className="af-pill af-pill--quiet" onClick={onDeny} disabled={u.busy}>Cancel</DialogButton>
             </SheetActions>
           }>
      <p className="af-note-line">The Notiq extension wants to {what}.</p>
      <VaultUnlockBody u={u} purpose={purpose} idPrefix="af-unlock" />
    </Sheet>
  );
}
