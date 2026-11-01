import { useState } from "react";
import { FingerprintPattern, X } from "lucide-react";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { RowIconButton, useAnnouncer, useListFocus } from "./ListEditor";
import { passkeyLabel, withoutPasskey, type StoredPasskey } from "../../lib/passkeyEntry";

const fmtDate = (ms: number) => (ms > 0 ? new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "");

/**
 * Passkeys saved on this login through the browser extension (experimental). Read-only: site, user and date;
 * a passkey can only be deleted here (its private key is never shown). Deleting it does not remove it from the
 * site's account settings.
 */
export function PasskeysList({ value, onChange }: { value: StoredPasskey[]; onChange: (next: StoredPasskey[]) => void }) {
  const [doomed, setDoomed] = useState<StoredPasskey | null>(null);
  const { rootRef, focusAfter } = useListFocus();
  const { announce, region } = useAnnouncer();
  // The live region stays mounted so "Passkey deleted" is still read when the last one goes.
  if (!value.length) return region;
  return (
    <div ref={rootRef}>
      {region}
      <span className="block text-xs mb-1 text-[var(--color-text-muted)]">Passkeys (experimental)</span>
      <ul className="flex flex-col gap-1" aria-label="Passkeys">
        {value.map((p) => (
          <li key={`${p.rpId} ${p.credentialId}`} data-list-row
              className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm bg-[var(--color-bg-tertiary)] border border-[var(--color-border)]">
            <FingerprintPattern size={14} className="shrink-0 text-[var(--color-text-muted)]" aria-hidden />
            <span className="flex-1 min-w-0 flex flex-col">
              <span className="truncate" title={p.rpId}>{p.rpId}</span>
              <span className="truncate text-xs text-[var(--color-text-muted)]">
                {[passkeyLabel(p), fmtDate(p.created) && `added ${fmtDate(p.created)}`].filter(Boolean).join(" · ")}
              </span>
            </span>
            <RowIconButton danger label={`Delete the passkey for ${passkeyLabel(p)} on ${p.rpId}`} tooltip="Delete this passkey"
                           icon={<X size={13} />} onClick={() => setDoomed(p)} />
          </li>
        ))}
      </ul>
      {doomed && (
        <ConfirmDialog
          title="Delete passkey?"
          message={`You won't be able to sign in to ${doomed.rpId} as ${passkeyLabel(doomed)} with this passkey any more. Remove it from the site's security settings too.`}
          confirmLabel="Delete"
          danger
          onConfirm={() => {
            const i = value.indexOf(doomed);
            onChange(withoutPasskey(value, doomed.rpId, doomed.credentialId));
            setDoomed(null);
            focusAfter({ index: Math.max(0, i), selector: "button" });
            announce(`Passkey for ${doomed.rpId} deleted`);
          }}
          onCancel={() => setDoomed(null)}
        />
      )}
    </div>
  );
}
