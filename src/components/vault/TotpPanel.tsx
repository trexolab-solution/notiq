import { useEffect, useState } from "react";
import { Input } from "../ui/Input";
import { TotpRing } from "../ui/TotpRing";
import { useAutoHide } from "../../hooks/useAutoHide";
import { CopyIconButton } from "./CopyIconButton";
import { FieldRow, RevealButton, Section } from "./EntryParts";
import { totpCode, totpRemaining } from "../../lib/loginEntry";

const PERIOD = 30;
/** Seconds left at which the code is about to change (the ring and the digits turn to the warning colour). */
const LOW = 5;

/** `123456` → `123 456`. */
const group = (c: string) => `${c.slice(0, 3)} ${c.slice(3)}`;

/**
 * "Two-step verification": the setup key (hidden by default, with Show and Copy) and, once it is a valid
 * key, the live code with a countdown ring. The key stays in the login; only the code is derived here.
 */
export function TotpPanel({ secret, onChange }: { secret: string; onChange: (secret: string) => void }) {
  const [show, setShow] = useState(false);
  useAutoHide(show, setShow);
  const [code, setCode] = useState<string | null>(null);
  const [left, setLeft] = useState(totpRemaining());
  const has = secret.trim().length > 0;

  useEffect(() => {
    if (!has) { setCode(null); return; }
    let alive = true;
    const tick = async () => {
      setLeft(totpRemaining());
      const c = await totpCode(secret);
      if (alive) setCode(c ? group(c) : null);
    };
    void tick();
    const id = setInterval(() => { void tick(); }, 1000);
    return () => { alive = false; clearInterval(id); };
  }, [secret, has]);

  const low = left <= LOW;
  return (
    <Section title="Two-step verification"
             hint="Optional. Paste the setup key a site shows next to its QR code, and Notiq shows the current code.">
      <FieldRow htmlFor="le-totp" text="Setup key" hint="· optional"
                actions={<>
                  <RevealButton shown={show} onToggle={() => setShow((v) => !v)} name="setup key" />
                  <CopyIconButton value={secret} label="setup key" />
                </>}
                error={has && !code ? "That doesn't look like a valid setup key." : null}>
        <Input id="le-totp" type={show ? "text" : "password"} value={secret} onChange={(e) => onChange(e.target.value)}
               placeholder="Base32 key, e.g. JBSW Y3DP EHPK 3PXP" autoComplete="off" spellCheck={false} className="font-mono" />
      </FieldRow>

      {code && (
        <div className="flex items-center gap-4 rounded-lg px-4 py-3 bg-[var(--color-bg-secondary)] border border-[var(--color-border)]"
             role="group" aria-label="Current verification code">
          <div className="flex flex-col gap-0.5 min-w-0">
            <span data-testid="totp-code" data-low={low ? "" : undefined}
                  className="font-mono text-2xl font-semibold tracking-[0.18em] tabular-nums leading-none transition-colors motion-reduce:transition-none"
                  style={{ color: low ? "var(--color-warning)" : "var(--color-text)" }}>
              {code}
            </span>
            <span className="text-xs text-[var(--color-text-muted)]">Current code · changes every {PERIOD} seconds</span>
          </div>
          <div className="flex-1" />
          <div className="flex items-center gap-1.5 shrink-0 text-xs tabular-nums text-[var(--color-text-muted)]">
            <TotpRing left={left} period={PERIOD} size={24} stroke={2.5} low={low} />
            <span aria-label={`${left} seconds left`} data-testid="totp-left" style={low ? { color: "var(--color-warning)" } : undefined}>{left}s</span>
          </div>
          <CopyIconButton value={code.replace(" ", "")} label="2-step code" />
        </div>
      )}
    </Section>
  );
}
