import { useCallback, useEffect, useRef, useState } from "react";
import { useWindowContextMenu } from "../hooks/useWindowContextMenu";
import type { FormEvent, ReactNode, RefObject } from "react";
import { flushSync } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { CreditCard, KeyRound, Lock, TriangleAlert, X } from "lucide-react";
import { DialogButton, DialogFooter, DialogIcon } from "../components/ui/DialogParts";
import { CardChoice, FillChoice, SaveFields } from "../components/vault/autofillBodies";
import { useVaultUnlock } from "../components/vault/unlock/useVaultUnlock";
import { VaultUnlockActions, VaultUnlockBody } from "../components/vault/unlock/VaultUnlockForm";
import { useDialogBehaviour } from "../components/ui/useDialogBehaviour";
import type { DefaultFocus } from "../components/ui/dialogLogic";
import { applyTheme } from "../lib/themes";
import { resolveVaultDir } from "../lib/vaultDir";
import { ERR_LOCKED, vaultStatus } from "../lib/vault";
import { nameError } from "../lib/vaultTree";
import { LOOKALIKE_REASON_TEXT } from "../lib/lookalike";
import {
  cardReply, clearTrust, credentialsFor, isFallbackRequest, isTrusted, saveLogin, scanCards, scanLogins, setVaultRootResolver,
  trustHost, type SaveRequest,
} from "../lib/autofill";
import { fitWindowSize, sizeChanged } from "./fitWindowSize";
import { splitHost } from "./hostParts";
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

export default function AutofillPromptApp() {
  // No clipboard permission in this window: just keep the webview's menu out.
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
      case "release":
        try {
          if (e.trustHost) trustHost(e.trustHost);
          await reply(e.id, { ok: true, ...(await credentialsFor(e.match)) });
        } catch {
          await reply(e.id, { error: "failed" });
        }
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
      listen<FillReq & { fallback?: boolean }>("autofill:request", (e) => {
        if (isFallbackRequest(e.payload)) return;
        const { id, host, account } = e.payload;
        accept({ kind: "fill", req: { id, host, ...(account ? { account } : {}) } });
      }),
      listen<SaveRequest & { fallback?: boolean }>("autofill:save", (e) => {
        if (isFallbackRequest(e.payload)) return;
        const { id, host, url, username, password, title } = e.payload;
        accept({ kind: "save", req: { id, host, url, username, password, title } });
      }),
      // Card requests come only to this window (Rust has no main-window fallback for them).
      listen<{ id: string; host: string }>("autofill:card", (e) => {
        const { id, host } = e.payload;
        accept({ kind: "card", req: { id, host } });
      }),
      listen<{ id: string }>("autofill:cancel", (e) => {
        queue.current = dropFromQueue(queue.current, e.payload.id);
        dispatch({ type: "cancel", id: e.payload.id });
      }),
      listen("autofill-prompt:dismiss", () => dispatch({ type: "deny" })),
      listen<{ unlocked: boolean; source?: string }>("vault:state-changed", (e) => {
        if (!e.payload.unlocked) {
          clearTrust();
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

  switch (state.stage) {
    case "checking":
      // Only seen right after an unlock in this window, while the vault is read (usually a blink).
      return (
        <Panel key={`checking-${state.job.req.id}`} refs={refs} host={state.job.req.host} icon="shield" onClose={deny}
               sub="Vault unlocked." footer={<DialogButton cancel onClick={deny}>Cancel</DialogButton>}>
          <p className="af-detail" role="status">
            {state.job.kind === "card" ? "Looking for saved cards…" : "Looking for saved logins for this site…"}
          </p>
        </Panel>
      );
    case "locked":
      return <LockedStage key={`locked-${state.job.req.id}`} refs={refs} job={state.job} dispatch={dispatch} onDeny={deny} />;
    case "request": {
      const { job, matches, pick, trust, busy } = state;
      return (
        <Panel key={`request-${job.req.id}`} refs={refs} host={job.req.host} icon="shield"
               sub="The Notiq extension in your browser wants to fill a saved login." onClose={deny} defaultFocus="cancel"
               footer={<>
                 <DialogButton cancel onClick={deny} disabled={busy}>Deny</DialogButton>
                 <DialogButton variant="primary" disabled={busy} onClick={() => dispatch({ type: "allow" })}>Allow</DialogButton>
               </>}>
          <p className="af-detail">Only allow this if you just pressed Fill on this site.</p>
          <FillChoice host={job.req.host} matches={matches} pick={pick} disabled={busy}
                      onPick={(index) => dispatch({ type: "pick", index })}
                      trust={trust} onTrust={(on) => dispatch({ type: "trust", on })} />
        </Panel>
      );
    }
    case "card": {
      const { job, cards, pick, busy } = state;
      return (
        <Panel key={`card-${job.req.id}`} refs={refs} host={job.req.host} icon={<CreditCard size={16} />}
               sub="The Notiq extension in your browser wants to fill a payment card." onClose={deny} defaultFocus="cancel"
               footer={<>
                 <DialogButton cancel onClick={deny} disabled={busy}>Deny</DialogButton>
                 <DialogButton variant="primary" disabled={busy} onClick={() => dispatch({ type: "allow" })}>Fill card</DialogButton>
               </>}>
          <p className="af-detail">Only allow this if you just pressed Fill on this site&rsquo;s checkout.</p>
          <CardChoice cards={cards} pick={pick} disabled={busy} onPick={(index) => dispatch({ type: "pick", index })} />
        </Panel>
      );
    }
    case "save": {
      const { job, plan, name, reveal, busy } = state;
      const update = plan.kind === "update";
      const nameErr = update ? null : nameError(name);
      const confirm = () => dispatch({ type: "confirmSave", nameOk: !nameErr });
      return (
        <Panel key={`save-${job.req.id}`} refs={refs} host={job.req.host} icon={<KeyRound size={16} />}
               sub={update ? "The Notiq extension wants to update a saved password." : "The Notiq extension wants to save a new login."}
               onClose={deny}
               footer={<>
                 <DialogButton cancel onClick={deny} disabled={busy}>Not now</DialogButton>
                 <DialogButton variant="primary" disabled={busy || !!nameErr} onClick={confirm}>{update ? "Update" : "Save"}</DialogButton>
               </>}>
          <p className="af-detail">Only save it if you just signed in on this site.</p>
          <SaveFields req={job.req} plan={plan} name={name} nameError={nameErr} reveal={reveal}
                      onName={(value) => dispatch({ type: "name", value })} onReveal={() => dispatch({ type: "reveal" })}
                      onEnter={confirm} />
        </Panel>
      );
    }
    case "warning":
      return (
        <Panel key={`warning-${state.host}`} refs={refs} host={state.host} icon={<TriangleAlert size={16} />} tone="danger"
               sub="Notiq did not fill this page." onClose={deny}
               footer={<DialogButton variant="primary" onClick={deny}>OK</DialogButton>}>
          <div className="dlg-callout dlg-callout--danger" role="alert">
            <TriangleAlert size={14} className="shrink-0 mt-0.5" aria-hidden />
            <span>
              This may be a fake site: it looks like <strong>{state.lookalike.saved}</strong>, which you have a login for,
              but it {LOOKALIKE_REASON_TEXT[state.lookalike.reason]}.
            </span>
          </div>
          <p className="af-detail">Nothing was sent to the page. Check the address before you type a password.</p>
        </Panel>
      );
  }
}

// ── pieces ──────────────────────────────────────────────────────────────────

interface Refs {
  headRef: RefObject<HTMLDivElement>;
  contentRef: RefObject<HTMLDivElement>;
  footRef: RefObject<HTMLDivElement>;
}

interface PanelProps {
  refs: Refs;
  host: string;
  sub: ReactNode;
  icon: "shield" | ReactNode;
  tone?: "primary" | "danger";
  onClose: () => void;
  defaultFocus?: DefaultFocus;
  onSubmit?: (e: FormEvent<HTMLFormElement>) => void;
  footer: ReactNode;
  children: ReactNode;
}

/** The whole window as one dialog: site header, scrolling body, footer. Esc / × = deny. */
function Panel({ refs, host, sub, icon, tone = "primary", onClose, defaultFocus, onSubmit, footer, children }: PanelProps) {
  const panelRef = useRef<HTMLElement | null>(null);
  useDialogBehaviour(panelRef, { onClose, dismissable: true, autoFocus: true, defaultFocus });
  const { prefix, site } = splitHost(host);
  const inner = (
    <>
      <div ref={refs.headRef} className="af-head" data-tauri-drag-region>
        {icon === "shield" ? <DialogIcon kind="shield" /> : <DialogIcon tone={tone}>{icon}</DialogIcon>}
        <div className="af-head-text" data-tauri-drag-region>
          <h1 className="af-host" id="af-title" title={host}>
            {prefix && <span className="af-host-prefix">{prefix}</span>}{site}
          </h1>
          <p className="af-sub" id="af-desc" data-tauri-drag-region>{sub}</p>
        </div>
        <button type="button" className="dlg-close" aria-label="Close" onClick={onClose}>
          <X size={14} strokeWidth={2} aria-hidden />
        </button>
      </div>
      <div className="af-scroll">
        <div ref={refs.contentRef} className="af-content">{children}</div>
      </div>
      <div ref={refs.footRef}>
        <DialogFooter>{footer}</DialogFooter>
      </div>
    </>
  );
  const common = {
    ref: panelRef as never,
    className: "af-window",
    role: "alertdialog" as const,
    "aria-modal": true,
    "aria-labelledby": "af-title",
    "aria-describedby": "af-desc",
    tabIndex: -1,
  };
  return onSubmit ? <form {...common} onSubmit={onSubmit}>{inner}</form> : <div {...common}>{inner}</div>;
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
  const what = job.kind === "fill" ? "fill a saved login" : job.kind === "card" ? "fill a payment card" : "save a login";
  const submitLabel = job.kind === "fill" ? "Unlock & fill" : job.kind === "card" ? "Unlock & pick card" : "Unlock & save";
  const purpose = job.kind === "fill" ? "unlock and fill it" : job.kind === "card" ? "unlock and pick a card" : "unlock and save it";
  return (
    <Panel refs={refs} host={job.req.host} icon={<Lock size={16} />} onClose={onDeny} onSubmit={u.submit}
           sub={`The Notiq extension wants to ${what}.`}
           footer={<VaultUnlockActions u={u} onCancel={onDeny} submitLabel={submitLabel} />}>
      <VaultUnlockBody u={u} purpose={purpose} idPrefix="af-unlock" />
    </Panel>
  );
}
