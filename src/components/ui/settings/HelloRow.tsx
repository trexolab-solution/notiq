import { useEffect, useState } from "react";
import { SettingRow } from "../SettingRow";
import { Button } from "../Button";
import { PasswordInput } from "../PasswordInput";
import { toast } from "../../../lib/toast";
import { useVaultStore } from "../../../store/vaultStore";
import { vaultErrorMessage } from "../../../lib/vault";
import { HELLO_OFF, helloDisable, helloEnable, helloStatus, isHelloCancel, type HelloStatus } from "../../../lib/hello";

const DESCRIPTION = "Unlock with your face, fingerprint or Windows PIN instead of typing the master password.";
const HELP =
  "Convenience unlock with your face, fingerprint or Windows PIN. Your master password stays the root secret: " +
  "it is still needed after you change your Windows Hello setup, after a restore or recovery, and whenever this is turned off. " +
  "Like any quick unlock, anyone who can use your signed-in Windows session can also unlock the vault.";

/** 0.7.0 — "Unlock with Windows Hello" (experimental, off by default). Hidden when Hello isn't available. */
export function HelloRow() {
  const exists = useVaultStore((s) => s.exists);
  const unlocked = useVaultStore((s) => s.unlocked);
  const [status, setStatus] = useState<HelloStatus | null>(null);
  const [asking, setAsking] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void helloStatus().then((s) => { if (live) setStatus(s); });
    return () => { live = false; };
  }, [exists, unlocked]);

  if (!status?.supported) return null; // platform without Windows Hello: row stays hidden

  const closeForm = () => { setAsking(false); setPassword(""); setError(null); };

  const enable = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!password) { setError("Enter your master password"); return; }
    setBusy(true);
    setError(null);
    try {
      await helloEnable(password);
      closeForm();
      setStatus({ supported: true, enabled: true });
      toast.info("Windows Hello unlock is on. Your master password still works as before.");
    } catch (err) {
      const msg = vaultErrorMessage(err);
      if (isHelloCancel(msg)) toast.info(msg); else setError(msg);
      setStatus(await helloStatus().catch(() => HELLO_OFF));
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await helloDisable();
      toast.info("Windows Hello unlock is off.");
    } catch (err) {
      toast.error(vaultErrorMessage(err));
    } finally {
      setStatus(await helloStatus().catch(() => HELLO_OFF));
      setBusy(false);
    }
  };

  const hint = !exists ? "Set up the vault first to turn this on."
    : !status.enabled && !unlocked ? "Unlock the vault to turn this on." : null;

  return (
    <>
      <SettingRow
        id="vault.quickunlock.hello"
        label="Windows Hello (experimental)"
        description={hint ?? DESCRIPTION}
        help={HELP}
        keywords={["windows hello", "fingerprint", "face", "pin", "biometric", "quick unlock", "unlock"]}
      >
        {status.enabled ? (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void disable()}>Turn off</Button>
        ) : !asking ? (
          <Button size="sm" disabled={!exists || !unlocked || busy} onClick={() => setAsking(true)}
                  title={unlocked ? undefined : "Unlock the vault first"}>
            Turn on
          </Button>
        ) : null}
      </SettingRow>
      {asking && !status.enabled && (
        <form onSubmit={enable} className="flex flex-col gap-2 max-w-sm">
          <PasswordInput placeholder="Master password" autoComplete="current-password" autoFocus
                         aria-label="Master password to turn on Windows Hello"
                         value={password} onChange={(e) => setPassword(e.target.value)} />
          <p className="text-xs text-[var(--color-text-muted)]">
            Windows will ask you to verify with Windows Hello (possibly more than once).
          </p>
          {error && <p role="alert" className="text-xs text-[var(--color-danger)]">{error}</p>}
          <div className="flex gap-2">
            <Button type="submit" size="sm" variant="primary" disabled={busy || !password}>
              {busy ? "Waiting for Windows Hello…" : "Turn on Windows Hello"}
            </Button>
            <Button type="button" size="sm" disabled={busy} onClick={closeForm}>Cancel</Button>
          </div>
        </form>
      )}
    </>
  );
}
