import { useState } from "react";
import { useWindowContextMenu } from "../hooks/useWindowContextMenu";
import { invoke } from "@tauri-apps/api/core";
import { Copy, CreditCard, IdCard, KeyRound, Timer } from "lucide-react";
import {
  cardAllowLabel, cardChoiceItems, CardChoice, fillAllowLabel, FillChoice, IdentityChoice, identityAllowLabel, identityChoiceItems,
  loginChoiceItems,
} from "../components/vault/autofillChoices";
import { COPY_LABEL } from "../lib/autofillPopup";
import { usePromptMachine } from "./prompt/usePromptMachine";
import { ChooserPanel } from "./prompt/ChooserPanel";
import { LockedStage } from "./prompt/LockedStage";
import { CheckingStage, PasskeyCreateStage, PasskeyGetStage, SaveStage, WarningStage } from "./prompt/stages";

/**
 * The browser-autofill approval window (label `autofill-prompt`, route `#/autofill-prompt`).
 *
 * Rust routes every `autofill:request` / `autofill:save` here and never raises the main window.
 * This window stays hidden unless it needs the user: a trusted site, no match or an unchanged save
 * is answered silently. Otherwise it sizes itself to its content, asks Rust to show it (centred,
 * always on top, focused), and after the answer hides again and hands the focus back to the browser.
 * The window lives for the whole session (hidden) so the 5-minute trust windows survive.
 *
 * The request queue and state machine are in ./prompt/usePromptMachine; each stage's view is in ./prompt.
 */
export default function AutofillPromptApp() {
  // No text menu here (copies go through the details view's copy buttons): just keep the webview's menu out.
  useWindowContextMenu({ textMenu: false });
  const { state, dispatch, shown, refs, details, setDetails } = usePromptMachine();
  /** The chooser's search text, for request `id` only (a new request starts with an empty search). */
  const [query, setQuery] = useState<{ id: string; q: string }>({ id: "", q: "" });

  if (state.stage === "idle" || (state.stage === "checking" && state.silent)) {
    // Nothing to show (the window is hidden, or about to be).
    return <div className="af-window" aria-hidden />;
  }

  const deny = () => dispatch({ type: "deny" });

  // ── details sub-view (logins, cards, identities) ──────────────────────────
  const reqId = "job" in state ? state.job.req.id : null;
  const viewing = details && details.id === reqId ? details.index : null;
  const openDetails = (index: number) => { if (reqId) setDetails({ id: reqId, index }); };
  const closeDetails = () => {
    const index = viewing;
    setDetails(null);
    // Back on the list: put the focus on the row's details button again.
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
  /** Enter / double-click on a row and "Fill this login" in the details view: the same as picking the row, then Allow. */
  const pickAndAllow = (index: number) => { dispatch({ type: "pick", index }); dispatch({ type: "allow" }); };
  const chooser = {
    refs, viewing, query: q, onDeny: deny, onAllow: () => dispatch({ type: "allow" }), onCloseDetails: closeDetails,
    onPickAndAllow: pickAndAllow, onOpenInNotiq: openInNotiq,
  };

  switch (state.stage) {
    case "checking":
      return <CheckingStage key={`checking-${state.job.req.id}`} refs={refs} state={state} onDeny={deny} />;
    case "locked":
      return <LockedStage key={`locked-${state.job.req.id}`} refs={refs} job={state.job} dispatch={dispatch} onDeny={deny} />;
    case "request": {
      const { job, matches, pick, trust, busy } = state;
      const { copy, intent } = job.req;
      return (
        <ChooserPanel
          key={`request-${job.req.id}`} {...chooser} host={job.req.host} busy={busy} entries={matches} items={loginChoiceItems(matches)}
          kind={copy ? { icon: <Copy size={11} />, label: `Copy ${COPY_LABEL[copy]}` }
            : intent === "code" ? { icon: <Timer size={11} />, label: "2-step code" } : { icon: <KeyRound size={11} />, label: "Login" }}
          trustNote={copy ? "Only allow this if you just pressed Copy in the Notiq extension." : "Only allow this if you just pressed Fill on this site."}
          allowLabel={fillAllowLabel(matches[pick], job.req)} busyText={copy ? "Copying…" : "Filling…"}
          fillLabel={copy ? `Copy the ${COPY_LABEL[copy]}` : intent === "code" ? "Fill this code" : "Fill this login"}
          list={
            <FillChoice host={job.req.host} matches={matches} pick={pick} disabled={busy} onPick={onPick} onAllow={pickAndAllow}
                        onDetails={openDetails} query={q} onQuery={onQuery}
                        trust={trust} onTrust={(on) => dispatch({ type: "trust", on })} />
          }
        />
      );
    }
    case "card": {
      const { job, cards, pick, busy } = state;
      return (
        <ChooserPanel
          key={`card-${job.req.id}`} {...chooser} host={job.req.host} busy={busy} entries={cards} items={cardChoiceItems(cards)}
          kind={{ icon: <CreditCard size={11} />, label: "Payment card" }}
          trustNote={<>Only allow this if you just pressed Fill on this site&rsquo;s checkout.</>}
          allowLabel={cardAllowLabel(cards[pick])} busyText="Filling…" fillLabel="Fill this card"
          list={
            <CardChoice cards={cards} pick={pick} disabled={busy} onPick={onPick} onAllow={pickAndAllow} onDetails={openDetails}
                        query={q} onQuery={onQuery} />
          }
        />
      );
    }
    case "identity": {
      const { job, identities, pick, busy } = state;
      return (
        <ChooserPanel
          key={`identity-${job.req.id}`} {...chooser} host={job.req.host} busy={busy} entries={identities} items={identityChoiceItems(identities)}
          kind={{ icon: <IdCard size={11} />, label: "Identity" }}
          trustNote={<>
            Your name, email, phone and address go to <strong className="af-host-inline">{job.req.host}</strong>. Only allow this
            if you just asked to fill a form there.
          </>}
          allowLabel={identityAllowLabel(identities[pick])} busyText="Filling…" fillLabel="Fill with this identity"
          list={
            <IdentityChoice identities={identities} pick={pick} disabled={busy} onPick={onPick} onAllow={pickAndAllow}
                            onDetails={openDetails} query={q} onQuery={onQuery} />
          }
        />
      );
    }
    case "save":
      return <SaveStage key={`save-${state.job.req.id}`} refs={refs} state={state} dispatch={dispatch} onDeny={deny} />;
    case "passkeyCreate":
      return <PasskeyCreateStage key={`passkey-create-${state.job.req.id}`} refs={refs} state={state} dispatch={dispatch} onDeny={deny} />;
    case "passkeyGet":
      return (
        <PasskeyGetStage key={`passkey-get-${state.job.req.id}`} refs={refs} state={state} dispatch={dispatch} onDeny={deny}
                         onPick={onPick} onPickAndAllow={pickAndAllow} />
      );
    case "warning":
      return <WarningStage key={`warning-${state.host}`} refs={refs} state={state} onDeny={deny} />;
  }
}
