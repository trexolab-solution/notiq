import { useState } from "react";
import type { ReactNode } from "react";
import { Copy, Printer } from "lucide-react";
import { Dialog, DialogBody, DialogButton, DialogCheckbox, DialogFooter } from "../ui/Dialog";
import { Button } from "../ui/Button";
import { RecoveryKitDialog } from "./RecoveryKitDialog";
import { toast } from "../../lib/toast";
import { copySecretTimed } from "../../lib/secureCopy";
import { clipboardClearLabel } from "../../lib/vaultPrefs";

/**
 * Shows a recovery key exactly once (copy / print kit), and can't be closed until the user confirms they saved
 * it. Used right after the vault is created and after "Create new recovery key" in Settings.
 */
export function RecoveryKeyDialog({ recoveryKey, onDone, detail, title = "Save your recovery key" }: {
  recoveryKey: string;
  /** "Done" (enabled once "I have saved my recovery key" is ticked). */
  onDone: () => void | Promise<void>;
  detail?: ReactNode;
  title?: string;
}) {
  const [saved, setSaved] = useState(false);
  const [showKit, setShowKit] = useState(false);

  const copyKey = async () => {
    // copySecretTimed keeps it out of clipboard history and clears it after the user's setting; it shows its own
    // error toast on failure.
    const secs = await copySecretTimed(recoveryKey, "Recovery key", { quiet: true });
    if (secs !== null) {
      toast.info(secs > 0
        ? `Recovery key copied — it clears from the clipboard in ${clipboardClearLabel(secs)}. Paste it somewhere safe now.`
        : "Recovery key copied. Paste it somewhere safe now.");
    }
  };

  return (
    <Dialog onClose={() => {}} dismissable={false} zClassName="z-[70]" size="sm" title={title} icon="shield">
      <DialogBody
        message={<>If you forget your master password, this key is the <b>only</b> way to open your locked notes.</>}
        detail={detail ?? "It is shown once and is not stored anywhere. Keep it somewhere safe and offline."}
      >
        <div
          className="font-mono text-sm tracking-wide text-center select-all break-all rounded-md p-3 mb-3 bg-[var(--color-bg-tertiary)] border border-[var(--color-border)]"
          data-testid="recovery-key"
        >
          {recoveryKey}
        </div>
        <div className="flex justify-end gap-2 mb-3">
          <Button size="sm" icon={<Printer size={12} />} onClick={() => setShowKit(true)}>Print recovery kit</Button>
          <Button size="sm" icon={<Copy size={12} />} onClick={copyKey}>Copy</Button>
        </div>
        {showKit && <RecoveryKitDialog recoveryKey={recoveryKey} onClose={() => setShowKit(false)} />}
        <DialogCheckbox checked={saved} onChange={setSaved} label="I have saved my recovery key" />
      </DialogBody>
      <DialogFooter>
        <DialogButton
          variant="primary"
          disabled={!saved}
          onClick={async () => {
            setShowKit(false);
            await onDone();
          }}
        >
          Done
        </DialogButton>
      </DialogFooter>
    </Dialog>
  );
}
