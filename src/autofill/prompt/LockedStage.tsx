import { getCurrentWindow } from "@tauri-apps/api/window";
import { Lock } from "lucide-react";
import { useVaultUnlock } from "../../components/vault/unlock/useVaultUnlock";
import { VaultUnlockActions, VaultUnlockBody } from "../../components/vault/unlock/VaultUnlockForm";
import { COPY_LABEL } from "../../lib/autofillPopup";
import type { Job, PromptEvent } from "../promptMachine";
import { jobHost, Panel, type Refs } from "./Panel";

interface LockedProps {
  refs: Refs;
  job: Job;
  dispatch: (ev: PromptEvent) => void;
  onDeny: () => void;
}

/** The vault is locked: the same unlock form as the main window (master password or Windows Hello). */
export function LockedStage({ refs, job, dispatch, onDeny }: LockedProps) {
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
  const unlockOnly = job.kind === "unlock";
  const what = unlockOnly ? "unlock your vault" : copy ? `copy the ${COPY_LABEL[copy]} of a saved login`
    : job.kind === "fill" ? (job.req.intent === "code" ? "fill a 2FA code" : "fill a saved login")
    : job.kind === "card" ? "fill a payment card" : job.kind === "identity" ? "fill your details (identity)"
    : job.kind === "passkeyCreate" ? `save a passkey for ${job.req.rpId}`
    : job.kind === "passkeyGet" ? `sign in to ${job.req.rpId} with a passkey` : "save a login";
  const submitLabel = unlockOnly ? "Unlock" : copy ? "Unlock & copy" : job.kind === "fill" ? "Unlock & fill" : job.kind === "card" ? "Unlock & pick card"
    : job.kind === "identity" ? "Unlock & pick identity" : job.kind === "passkeyGet" ? "Unlock & continue"
    : job.kind === "passkeyCreate" ? "Unlock & continue" : "Unlock & save";
  const purpose = unlockOnly ? "unlock the vault" : copy ? "unlock and copy it" : job.kind === "fill" ? "unlock and fill it" : job.kind === "card" ? "unlock and pick a card"
    : job.kind === "identity" ? "unlock and pick an identity" : job.kind === "passkeyGet" ? "unlock and pick a passkey"
    : job.kind === "passkeyCreate" ? "unlock and save the passkey" : "unlock and save it";
  return (
    <Panel refs={refs} host={jobHost(job)} title={unlockOnly ? "Unlock Notiq" : undefined} icon={<Lock size={16} />} onClose={onDeny} onSubmit={u.submit}
           sub={`The Notiq extension wants to ${what}.`}
           footer={<VaultUnlockActions u={u} onCancel={onDeny} submitLabel={submitLabel} />}>
      <VaultUnlockBody u={u} purpose={purpose} idPrefix="af-unlock" />
    </Panel>
  );
}
