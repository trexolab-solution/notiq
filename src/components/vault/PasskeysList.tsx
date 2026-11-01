import { useState } from "react";
import { FingerprintPattern, X } from "lucide-react";
import { Button } from "../ui/Button";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { Tooltip } from "../ui/Tooltip";
import { passkeyLabel, withoutPasskey, type StoredPasskey } from "../../lib/passkeyEntry";

const fmtDate = (ms: number) => (ms > 0 ? new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "");

/**
 * Passkeys saved on this login through the browser extension (experimental). Read-only: site, user and date;
 * a passkey can only be deleted here (its private key is never shown). Deleting it does not remove it from the
 * site's account settings.
 */
export function PasskeysList({ value, onChange }: { value: StoredPasskey[]; onChange: (next: StoredPasskey[]) => void }) {
  const [doomed, setDoomed] = useState<StoredPasskey | null>(null);
  if (!value.length) return null;
  return (
    <div>
      <span className="block text-xs mb-1 text-[var(--color-text-muted)]">Passkeys (experimental)</span>
      <ul className="flex flex-col gap-1" aria-label="Passkeys">
        {value.map((p) => (
          <li key={`${p.rpId} ${p.credentialId}`}
              className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm bg-[var(--color-bg-tertiary)] border border-[var(--color-border)]">
            <FingerprintPattern size={14} className="shrink-0 text-[var(--color-text-muted)]" aria-hidden />
            <span className="flex-1 min-w-0 flex flex-col">
              <span className="truncate" title={p.rpId}>{p.rpId}</span>
              <span className="truncate text-xs text-[var(--color-text-muted)]">
                {[passkeyLabel(p), fmtDate(p.created) && `added ${fmtDate(p.created)}`].filter(Boolean).join(" · ")}
              </span>
            </span>
            <Tooltip content="Delete this passkey">
              <Button size="sm" variant="danger" aria-label={`Delete the passkey for ${passkeyLabel(p)} on ${p.rpId}`}
                      icon={<X size={12} />} onClick={() => setDoomed(p)} />
            </Tooltip>
          </li>
        ))}
      </ul>
      {doomed && (
        <ConfirmDialog
          title="Delete passkey?"
          message={`You won't be able to sign in to ${doomed.rpId} as ${passkeyLabel(doomed)} with this passkey any more. Remove it from the site's security settings too.`}
          confirmLabel="Delete"
          danger
          onConfirm={() => { onChange(withoutPasskey(value, doomed.rpId, doomed.credentialId)); setDoomed(null); }}
          onCancel={() => setDoomed(null)}
        />
      )}
    </div>
  );
}
