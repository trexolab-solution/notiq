import { FingerprintPattern, KeyRound, TriangleAlert } from "lucide-react";
import { DialogButton } from "../../components/ui/DialogParts";
import { SaveFields } from "../../components/vault/autofillBodies";
import { InlineLoading } from "../../components/ui/Loading";
import { nameError } from "../../lib/vaultTree";
import { LOOKALIKE_REASON_TEXT } from "../../lib/lookalike";
import { hasSaveChoice } from "../../lib/autofill";
import { PasskeyChoice, PasskeyTargetChoice } from "../PasskeyChoices";
import type { PromptEvent, PromptState } from "../promptMachine";
import { jobHost, Panel, type Refs } from "./Panel";

type Stage<K extends PromptState["stage"]> = Extract<PromptState, { stage: K }>;

interface StageProps<K extends PromptState["stage"]> {
  refs: Refs;
  state: Stage<K>;
  dispatch: (ev: PromptEvent) => void;
  onDeny: () => void;
}

/** Only seen right after an unlock in this window, while the vault is read (usually a blink). */
export function CheckingStage({ refs, state, onDeny }: Omit<StageProps<"checking">, "dispatch">) {
  return (
    <Panel refs={refs} host={jobHost(state.job)} icon="shield" onClose={onDeny}
           sub="Vault unlocked." footer={<DialogButton cancel onClick={onDeny}>Cancel</DialogButton>}>
      <InlineLoading delay={0} className="af-state"
                     label={state.job.kind === "card" ? "Looking for saved cards…"
                       : state.job.kind === "identity" ? "Looking for saved identities…"
                       : state.job.kind === "passkeyGet" ? "Looking for saved passkeys…" : "Looking for saved logins for this site…"} />
    </Panel>
  );
}

/** Save a new login, or update a saved password. */
export function SaveStage({ refs, state, dispatch, onDeny }: StageProps<"save">) {
  const { job, plan, name, reveal, busy } = state;
  const update = plan.kind === "update";
  const nameErr = update ? null : nameError(name);
  const confirm = () => dispatch({ type: "confirmSave", nameOk: !nameErr });
  const choice = hasSaveChoice(plan);
  return (
    <Panel refs={refs} host={job.req.host} icon={<KeyRound size={16} />}
           sub={update ? "The Notiq extension wants to update a saved password." : "The Notiq extension wants to save a new login."}
           onClose={onDeny}
           footer={<>
             <DialogButton cancel onClick={onDeny} disabled={busy}>Not now</DialogButton>
             {update && choice && (
               <DialogButton disabled={busy} onClick={() => dispatch({ type: "saveAsNew", on: true })}>Save as new</DialogButton>
             )}
             <DialogButton variant="primary" disabled={!!nameErr} loading={busy} loadingText={update ? "Updating…" : "Saving…"}
                           onClick={confirm}>{update ? "Update" : "Save"}</DialogButton>
           </>}>
      <p className="af-detail">Only save it if you just signed in on this site.</p>
      <SaveFields req={job.req} plan={plan} name={name} nameError={nameErr} reveal={reveal} disabled={busy}
                  username={state.username} onUsername={(value) => dispatch({ type: "username", value })}
                  onName={(value) => dispatch({ type: "name", value })} onReveal={() => dispatch({ type: "reveal" })}
                  onTarget={(index) => dispatch({ type: "saveTarget", index })}
                  onSaveAsNew={(on) => dispatch({ type: "saveAsNew", on })}
                  onEnter={confirm} />
    </Panel>
  );
}

/** Save a new passkey (experimental), or tell the site Notiq already has one for this account. */
export function PasskeyCreateStage({ refs, state, dispatch, onDeny }: StageProps<"passkeyCreate">) {
  const { job, logins, pick, excluded, busy } = state;
  const who = job.req.userName || job.req.displayName;
  if (excluded) {
    return (
      <Panel refs={refs} host={job.req.host} icon={<FingerprintPattern size={16} />}
             sub={`Save a passkey for ${job.req.rpId}?`} onClose={onDeny} defaultFocus="cancel"
             footer={<>
               <DialogButton cancel onClick={onDeny}>Cancel</DialogButton>
               <DialogButton variant="primary" onClick={() => dispatch({ type: "allow" })}>OK</DialogButton>
             </>}>
        <p className="af-detail">
          Notiq already has a passkey for {who ? <strong>{who}</strong> : "this account"} on {job.req.rpId}. Nothing new
          is saved. Press OK to tell the site, or Cancel to use another passkey from your browser instead.
        </p>
      </Panel>
    );
  }
  return (
    <Panel refs={refs} host={job.req.host} icon={<FingerprintPattern size={16} />}
           sub={`Save a passkey for ${job.req.rpId}?`} onClose={onDeny} defaultFocus="cancel"
           footer={<>
             <DialogButton cancel onClick={onDeny} disabled={busy}>Not now</DialogButton>
             <DialogButton variant="primary" loading={busy} loadingText="Saving…" onClick={() => dispatch({ type: "allow" })}>Save passkey</DialogButton>
           </>}>
      <p className="af-detail">
        The Notiq extension wants to save a new passkey{who ? <> for <strong>{who}</strong></> : null} in your vault
        (experimental). Only save it if you just chose to create a passkey on this site.
      </p>
      <PasskeyTargetChoice logins={logins} pick={pick} disabled={busy} onPick={(index) => dispatch({ type: "pick", index })} />
    </Panel>
  );
}

/** Sign in with a saved passkey (experimental). */
export function PasskeyGetStage({ refs, state, dispatch, onDeny, onPick, onPickAndAllow }: StageProps<"passkeyGet"> & {
  onPick: (index: number) => void; onPickAndAllow: (index: number) => void;
}) {
  const { job, passkeys, pick, busy } = state;
  return (
    <Panel refs={refs} host={job.req.host} icon={<FingerprintPattern size={16} />}
           sub={`Sign in to ${job.req.rpId} with a passkey?`} onClose={onDeny} defaultFocus="cancel"
           footer={<>
             <DialogButton cancel onClick={onDeny} disabled={busy}>Deny</DialogButton>
             <DialogButton variant="primary" loading={busy} loadingText="Signing in…" onClick={() => dispatch({ type: "allow" })}>Sign in</DialogButton>
           </>}>
      <p className="af-detail">Only allow this if you just chose to sign in with a passkey on this site.</p>
      <PasskeyChoice passkeys={passkeys} pick={pick} disabled={busy} onPick={onPick} onAllow={onPickAndAllow} />
    </Panel>
  );
}

/** The page looks like a fake copy of a site the user has a login for: nothing was filled. */
export function WarningStage({ refs, state, onDeny }: Omit<StageProps<"warning">, "dispatch">) {
  return (
    <Panel refs={refs} host={state.host} icon={<TriangleAlert size={16} />} tone="danger"
           sub="Notiq did not fill this page." onClose={onDeny}
           footer={<DialogButton variant="primary" onClick={onDeny}>OK</DialogButton>}>
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
