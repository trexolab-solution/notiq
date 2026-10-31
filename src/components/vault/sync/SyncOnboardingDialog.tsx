import { useEffect, useState } from "react";
import { Cloud, Loader2 } from "lucide-react";
import { Dialog, DialogBody, DialogButton, DialogFooter } from "../../ui/Dialog";
import { useSyncStore } from "../../../lib/vaultSync";
import { turnOnSyncWithFeedback } from "../../../lib/syncFeedback";
import { markSyncBannerDone, setIndicatorTipPending } from "../../../lib/syncLifecycle";
import { AdoptRemoteDialog } from "./AdoptRemoteDialog";
import { ConnectWaiting } from "./ConnectWaiting";
import { useSyncConnect } from "./useSyncConnect";
import { toast } from "../../../lib/toast";

export type OnboardingPhase = "ask" | "connecting" | "enabling";

/** "Not now": no sync; the status-bar indicator explains where sync lives, once. */
export function chooseNotNow(onClose: () => void): void {
  setIndicatorTipPending();
  onClose();
}

/** The step's body + buttons (no hooks, so tests can render it and press its buttons). */
export function SyncOnboardingContent({ phase, connected, error, onConnect, onNotNow, onCancelConnect }: {
  phase: OnboardingPhase;
  /** Already signed in to Google: the main button just turns sync on. */
  connected: boolean;
  error: string | null;
  onConnect: () => void;
  onNotNow: () => void;
  onCancelConnect: () => void;
}) {
  return (
    <>
      <DialogBody>
        <p className="dlg-detail dlg-detail--block mb-3">
          Keep this vault in your own Google Drive and open it on your other PCs with the same master password.
          Everything is encrypted on this PC before it's uploaded, and Notiq can only see its own files in your Drive.
        </p>
        {phase === "connecting" && <ConnectWaiting onCancel={onCancelConnect} />}
        {phase === "enabling" && (
          <p className="text-sm inline-flex items-center gap-2" aria-live="polite">
            <Loader2 size={14} className="animate-spin" aria-hidden /> Uploading your vault…
          </p>
        )}
        {phase === "ask" && (
          <p className="text-xs text-[var(--color-text-muted)]">You can turn this on later in Settings → Vault → Sync.</p>
        )}
        {error && <p role="alert" className="text-xs mt-3 text-[var(--color-danger)]">{error}</p>}
      </DialogBody>
      <DialogFooter>
        <DialogButton cancel onClick={onNotNow} disabled={phase === "enabling"}>Not now</DialogButton>
        <DialogButton variant="primary" onClick={onConnect} disabled={phase !== "ask"}>
          {connected ? "Turn on sync" : "Connect Google Drive"}
        </DialogButton>
      </DialogFooter>
    </>
  );
}

/**
 * After a NEW vault is created (recovery key saved): "Use this vault on your other PCs?".
 * Connect → Google sign-in (Waiting… + Cancel) → turn sync on with first-upload feedback.
 * Only mounted when this build has Google sign-in (see `shouldOfferSyncOnboarding`).
 */
export function SyncOnboardingDialog({ onClose }: { onClose: () => void }) {
  const connected = useSyncStore((s) => !!s.status?.provider);
  const [phase, setPhase] = useState<OnboardingPhase>("ask");
  const [error, setError] = useState<string | null>(null);
  const [adopting, setAdopting] = useState(false);

  // A new vault user answers here; the "New: sync your vault" banner is for existing vaults only.
  useEffect(() => { markSyncBannerDone(); }, []);

  const enable = async () => {
    setPhase("enabling");
    const out = await turnOnSyncWithFeedback();
    if (out.kind === "different") { setAdopting(true); return; }
    if (out.kind === "error") { setPhase("ask"); setError(out.error); return; }
    onClose();
  };

  const { connecting, error: connectError, connect, cancel } = useSyncConnect((s) => {
    toast.success(`Connected to Google Drive${s.account ? ` as ${s.account}` : ""}`, { source: "Vault sync" });
    void enable();
  });

  const shown: OnboardingPhase = connecting ? "connecting" : phase;

  if (adopting) {
    return (
      <AdoptRemoteDialog onClose={(done) => {
        if (done) toast.success("Sync is on. This PC now uses the vault from your Google Drive.");
        void useSyncStore.getState().refresh();
        onClose();
      }} />
    );
  }

  return (
    <Dialog onClose={() => chooseNotNow(onClose)} dismissable={shown !== "enabling"} zClassName="z-[70]" size="sm"
            title="Use this vault on your other PCs?" icon={<Cloud size={16} />}>
      <SyncOnboardingContent
        phase={shown}
        connected={connected}
        error={error ?? connectError}
        onConnect={() => { setError(null); if (connected) void enable(); else void connect(); }}
        onNotNow={() => { cancel(); chooseNotNow(onClose); }}
        onCancelConnect={cancel}
      />
    </Dialog>
  );
}
