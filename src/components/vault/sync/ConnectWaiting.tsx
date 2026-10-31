import { Loader2 } from "lucide-react";
import { Button } from "../../ui/Button";
import { WAITING_FOR_GOOGLE } from "./useSyncConnect";

/** "Waiting for Google sign-in in your browser…" + Cancel — shown wherever `useSyncConnect` is waiting. */
export function ConnectWaiting({ onCancel }: { onCancel: () => void }) {
  return (
    <div className="flex items-center gap-2 text-sm" aria-live="polite" data-testid="connect-waiting">
      <Loader2 size={14} className="animate-spin shrink-0" aria-hidden />
      <span className="flex-1">{WAITING_FOR_GOOGLE}</span>
      <Button size="sm" onClick={onCancel}>Cancel</Button>
    </div>
  );
}
