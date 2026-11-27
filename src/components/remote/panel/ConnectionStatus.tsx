import { useState } from "react";
import { RefreshCw, ShieldQuestion } from "lucide-react";
import { DialogButton } from "../../ui/Dialog";
import { CopyIconButton } from "../../vault/CopyIconButton";
import { parseUnknownHost, type UnknownHost } from "../../../lib/sftp";
import type { Link } from "./types";

/** Shown while signing in. */
export function ConnectingNote({ server }: { server: string }) {
  return <p className="m-auto text-sm text-[var(--color-text-muted)]" role="status">Connecting to {server}…</p>;
}

/** The file on the server that holds a host key of this type, to compare its fingerprint with. */
const hostKeyFile = (alg: string) =>
  `/etc/ssh/ssh_host_${alg.includes("ed25519") ? "ed25519" : alg.startsWith("ecdsa") ? "ecdsa" : "rsa"}_key.pub`;

/** First connection to a server: its key's fingerprint, and the user's decision whether to trust it. */
function TrustHost({ host, onTrust, onDecline }: { host: UnknownHost; onTrust: () => void; onDecline: () => void }) {
  const check = `ssh-keygen -lf ${hostKeyFile(host.alg)}`;
  const box = "flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] pl-3 pr-1 py-1";
  return (
    <div className="m-auto w-full max-w-lg px-6" role="alertdialog" aria-labelledby="trust-host-title" aria-describedby="trust-host-why">
      <div className="flex flex-col gap-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/40 p-6">
        <div className="flex items-start gap-3">
          <ShieldQuestion size={22} aria-hidden className="shrink-0 text-[var(--color-warning)]" />
          <div className="min-w-0">
            <p id="trust-host-title" className="text-sm font-semibold">Trust this server?</p>
            <p className="mt-0.5 text-xs break-all text-[var(--color-text-muted)]">{host.host} · port {host.port}</p>
          </div>
        </div>
        <p id="trust-host-why" className="text-sm text-[var(--color-text-muted)]">
          This is the first time Notiq connects to it. Trust it only if this fingerprint is your server's; otherwise someone
          could be posing as the server to get your sign-in.
        </p>
        <div>
          <p className="mb-1 text-xs text-[var(--color-text-muted)]">{host.alg} key fingerprint</p>
          <div className={box}>
            <code className="flex-1 min-w-0 break-all text-xs font-mono">{host.fp}</code>
            <CopyIconButton value={host.fp} label="fingerprint" />
          </div>
        </div>
        <div>
          <p className="mb-1 text-xs text-[var(--color-text-muted)]">To check it, run this on the server (for example from your provider's web console)</p>
          <div className={box}>
            <code className="flex-1 min-w-0 break-all text-xs font-mono">{check}</code>
            <CopyIconButton value={check} label="command" />
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <DialogButton onClick={onDecline}>Don't trust</DialogButton>
          <DialogButton variant="primary" onClick={onTrust}>Trust and connect</DialogButton>
        </div>
      </div>
    </div>
  );
}

/** Signing in failed: why, and a button to try again. A server that isn't trusted yet is asked about instead. */
export function ConnectFailed({ failure, onRetry }: { failure: string; onRetry: (trust?: UnknownHost) => void }) {
  const unknown = parseUnknownHost(failure);
  /** The failure the user said no to (a later attempt asks again). */
  const [declined, setDeclined] = useState("");
  if (unknown && declined !== failure) {
    return <TrustHost host={unknown} onTrust={() => onRetry(unknown)} onDecline={() => setDeclined(failure)} />;
  }
  return (
    <div className="m-auto max-w-md text-center px-6" role="alert">
      <p className="text-sm font-medium">Couldn't open the file manager</p>
      <p className="mt-2 text-sm text-[var(--color-text-muted)] whitespace-pre-wrap">
        {unknown ? "You didn't trust this server's key, so nothing was sent to it." : failure}
      </p>
      <div className="mt-4 flex justify-center"><DialogButton variant="primary" onClick={() => { setDeclined(""); onRetry(); }}>Try again</DialogButton></div>
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
