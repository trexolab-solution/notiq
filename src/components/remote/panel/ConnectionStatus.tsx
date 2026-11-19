import { RefreshCw } from "lucide-react";
import { DialogButton } from "../../ui/Dialog";
import type { Link } from "./types";

/** Shown while signing in. */
export function ConnectingNote({ server }: { server: string }) {
  return <p className="m-auto text-sm text-[var(--color-text-muted)]" role="status">Connecting to {server}…</p>;
}

/** Signing in failed: why, and a button to try again. */
export function ConnectFailed({ failure, onRetry }: { failure: string; onRetry: () => void }) {
  return (
    <div className="m-auto max-w-md text-center px-6" role="alert">
      <p className="text-sm font-medium">Couldn't open the file manager</p>
      <p className="mt-2 text-sm text-[var(--color-text-muted)] whitespace-pre-wrap">{failure}</p>
      <div className="mt-4 flex justify-center"><DialogButton variant="primary" onClick={onRetry}>Try again</DialogButton></div>
    </div>
  );
}

/** The connection dropped: reconnecting, or lost for good (with a Reconnect button). Nothing while it is fine. */
export function ConnectionBanner({ link, onReconnect }: { link: Link; onReconnect: () => void }) {
  if (link === "ok") return null;
  return (
    <div role="status" className="flex items-center gap-2 px-3 h-9 shrink-0 text-sm border-b border-[var(--color-border)] bg-[var(--color-warning,#d97706)]/15">
      <span className="flex-1 min-w-0 truncate">
        {link === "reconnecting" ? "Connection lost. Reconnecting…" : "Connection lost. Your changes and transfers can't continue until it is back."}
      </span>
      {link === "lost" && <DialogButton variant="primary" icon={<RefreshCw size={13} />} onClick={onReconnect}>Reconnect</DialogButton>}
    </div>
  );
}
