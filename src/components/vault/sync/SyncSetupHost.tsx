import { useEffect, useState } from "react";
import { Cloud, CloudUpload, ShieldPlus } from "lucide-react";
import { Dialog, DialogBody, DialogButton, DialogFooter } from "../../ui/Dialog";
import { NO_DRIVE_VAULT_TEXT, REUPLOAD_TITLE, lastChangedText, reuploadQuestion, uploadQuestion } from "../../../lib/syncSetup";
import { listenForSetupRequests, useSyncSetupStore } from "../../../lib/syncSetupFlow";
import { ConnectWaiting } from "./ConnectWaiting";
import { DriveVaultFields } from "./DriveVaultCard";
import { TwoVaultsDialog } from "./AdoptRemoteDialog";
import { InlineLoading } from "../../ui/Loading";
import { DeletionGuardDialog } from "./DeletionGuardDialog";

const Z = "z-[80]";

/**
 * Mounted once (next to the vault dialog). Renders the current step of the sync setup flow and starts the flow
 * on `notiq:sync-start-setup` (the title bar / status bar popover's "Connect Google Drive").
 */
export function SyncSetupHost() {
  return (
    <>
      <SetupSteps />
      <DeletionGuardDialog />
    </>
  );
}

function SetupSteps() {
  useEffect(() => listenForSetupRequests(), []);

  const s = useSyncSetupStore();
  const { view, busy, error, account, devices, cancel } = s;

  switch (view.step) {
    case "idle":
      return null;

    case "notConfigured":
      return (
        <Dialog onClose={cancel} zClassName={Z} size="sm" title="Vault sync" icon={<Cloud size={16} />}>
          <DialogBody message="Sync with Google Drive isn't available in this build of Notiq."
                      detail="Your vault still works on this PC. Use a backup file to move it to another PC." />
          <DialogFooter><DialogButton variant="primary" onClick={cancel}>Close</DialogButton></DialogFooter>
        </Dialog>
      );

    case "connecting":
      return (
        <Dialog onClose={cancel} zClassName={Z} size="sm" title="Connect Google Drive" icon={<Cloud size={16} />}>
          <DialogBody>
            <p className="dlg-detail dlg-detail--block mb-3">
              Sign in to Google in your browser. Notiq can only see its own files in your Drive.
            </p>
            <ConnectWaiting onCancel={cancel} />
          </DialogBody>
        </Dialog>
      );

    case "checking":
      return (
        <Dialog onClose={cancel} zClassName={Z} size="sm" title="Vault sync" icon={<Cloud size={16} />}>
          <DialogBody>
            <InlineLoading label="Checking your Google Drive…" reserveSpace
                           slowHint="Still checking. This can take a moment on a slow connection." />
          </DialogBody>
          <DialogFooter><DialogButton cancel onClick={cancel}>Cancel</DialogButton></DialogFooter>
        </Dialog>
      );

    case "openDrive":
      return <OpenDriveStep key="open" replaceLocal={view.replaceLocal} />;

    case "create":
      return (
        <Dialog onClose={cancel} zClassName={Z} size="sm" title={NO_DRIVE_VAULT_TEXT} icon={<ShieldPlus size={16} />}>
          <DialogBody
            message={account ? `There's no vault in ${account} yet.` : "There's no vault in your Google Drive yet."}
            detail="Create your vault on this PC. It's uploaded to Google Drive and stays in sync. Use the same master password on your other PCs."
          />
          <DialogFooter>
            <DialogButton cancel onClick={cancel}>Cancel</DialogButton>
            <DialogButton variant="primary" onClick={() => void s.createVault()}>Create a new vault</DialogButton>
          </DialogFooter>
        </Dialog>
      );

    case "upload":
      return (
        <Dialog onClose={s.declineUpload} zClassName={Z} size="sm" title={uploadQuestion(view.items)} icon={<CloudUpload size={16} />}>
          <DialogBody
            message={`Your vault is encrypted on this PC, then uploaded to ${account ?? "your Google Drive"}.`}
            detail="After that it stays in sync on every PC where you open it."
          />
          <DialogFooter>
            <DialogButton cancel onClick={s.declineUpload}>Not now</DialogButton>
            <DialogButton variant="primary" onClick={() => void s.confirmUpload()}>Upload</DialogButton>
          </DialogFooter>
        </Dialog>
      );

    case "reupload":
      // Resume found an empty Drive: ask, never upload silently. Cancel keeps sync paused.
      return (
        <Dialog onClose={s.declineUpload} zClassName={Z} size="sm" title={REUPLOAD_TITLE} icon={<CloudUpload size={16} />}>
          <DialogBody
            message={reuploadQuestion(view.items)}
            detail={`It's encrypted on this PC, then uploaded to ${account ?? "your Google Drive"}. Your other PCs sync with it again after that.`}
          />
          <DialogFooter>
            <DialogButton cancel onClick={s.declineUpload}>Cancel</DialogButton>
            <DialogButton variant="primary" onClick={() => void s.confirmUpload()}>Upload</DialogButton>
          </DialogFooter>
        </Dialog>
      );

    case "twoVaults":
      return (
        <TwoVaultsDialog
          items={view.items} lastChanged={lastChangedText(devices)} busy={busy} error={error}
          onContinue={(choice, remotePw) => void s.chooseTwoVaults(choice, remotePw)}
          onKeepSeparate={() => void s.chooseTwoVaults("cancel", "")}
          onEdit={s.clearError}
        />
      );

    case "error":
      return (
        <Dialog onClose={cancel} zClassName={Z} size="sm" title="Vault sync" icon="warning">
          <DialogBody message="Couldn't finish setting up sync." detail={view.message} />
          <DialogFooter>
            <DialogButton cancel onClick={cancel}>Close</DialogButton>
            <DialogButton variant="primary" onClick={() => void s.retry()}>Try again</DialogButton>
          </DialogFooter>
        </Dialog>
      );
  }
}

/** F2 "Your vault is in Google Drive": master password → Open vault. */
function OpenDriveStep({ replaceLocal }: { replaceLocal: boolean }) {
  const { busy, error, account, devices, cancel, submitDrivePassword, clearError } = useSyncSetupStore();
  const [password, setPassword] = useState("");
  return (
    <Dialog onClose={cancel} dismissable={!busy} zClassName={Z} size="sm" title="Your vault is in Google Drive" icon={<Cloud size={16} />}
            onSubmit={(e) => { e.preventDefault(); void submitDrivePassword(password); }}>
      <DialogBody>
        <DriveVaultFields
          idPrefix="setup-drive" account={account} devices={devices} password={password} autoFocus
          onPassword={(v) => { setPassword(v); clearError(); }} busy={busy} error={error} replaceLocal={replaceLocal}
        />
      </DialogBody>
      <DialogFooter>
        <DialogButton cancel onClick={cancel} disabled={busy}>Cancel</DialogButton>
        <DialogButton type="submit" variant="primary" loading={busy} loadingText="Opening…">Open vault</DialogButton>
      </DialogFooter>
    </Dialog>
  );
}
