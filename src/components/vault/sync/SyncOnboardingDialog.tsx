import { useEffect } from "react";
import { Cloud } from "lucide-react";
import { Dialog, DialogBody, DialogButton, DialogFooter } from "../../ui/Dialog";
import { markSyncBannerDone, setIndicatorTipPending } from "../../../lib/syncLifecycle";
import { startSyncSetup } from "../../../lib/syncSetupFlow";

/** "Not now": no sync; the title bar sync button explains where sync lives, once. */
export function chooseNotNow(onClose: () => void): void {
  setIndicatorTipPending();
  onClose();
}

/** "Turn on sync with Google Drive": the one setup flow (sign-in → Drive check → upload, or open the Drive vault). */
export function chooseTurnOn(onClose: () => void): void {
  onClose();
  void startSyncSetup({ autoUpload: true });
}

/** The step's body + buttons (no hooks, so tests can render it and press its buttons). */
export function SyncOnboardingContent({ onTurnOn, onNotNow }: { onTurnOn: () => void; onNotNow: () => void }) {
  return (
    <>
      <DialogBody>
        <p className="dlg-detail dlg-detail--block">
          Keep this vault in your Google Drive and open it on your other PCs with the same master password.
          It's encrypted before it leaves this PC.
        </p>
      </DialogBody>
      <DialogFooter>
        <DialogButton cancel onClick={onNotNow}>Not now</DialogButton>
        <DialogButton variant="primary" onClick={onTurnOn}>Turn on sync with Google Drive</DialogButton>
      </DialogFooter>
    </>
  );
}

/**
 * After a NEW vault is created (recovery key saved): "Use this vault on your other PCs?".
 * Only mounted when this build has Google sign-in (see `shouldOfferSyncOnboarding`).
 */
export function SyncOnboardingDialog({ onClose }: { onClose: () => void }) {
  // A new vault user answers here; the "New: sync your vault" banner is for existing vaults only.
  useEffect(() => { markSyncBannerDone(); }, []);
  return (
    <Dialog onClose={() => chooseNotNow(onClose)} zClassName="z-[70]" size="sm"
            title="Use this vault on your other PCs?" icon={<Cloud size={16} />}>
      <SyncOnboardingContent onTurnOn={() => chooseTurnOn(onClose)} onNotNow={() => chooseNotNow(onClose)} />
    </Dialog>
  );
}
