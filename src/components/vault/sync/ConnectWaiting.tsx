import { Button } from "../../ui/Button";
import { Spinner } from "../../ui/Loading";
import { WAITING_FOR_GOOGLE } from "./useSyncConnect";

/** "Waiting for Google sign-in in your browser…" + Cancel — shown wherever `useSyncConnect` is waiting. */
export function ConnectWaiting({ onCancel }: { onCancel: () => void }) {
  return (
    <div className="flex items-center gap-2 text-sm" role="status" aria-live="polite" data-testid="connect-waiting">
      <Spinner size={14} />
      <span className="flex-1">{WAITING_FOR_GOOGLE}</span>
      <Button size="sm" onClick={onCancel}>Cancel</Button>
    </div>
  );
}
