import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { vaultErrorMessage, vaultUnlock } from "../../../lib/vault";
import { helloStatus, helloUnlock, isHelloCancel } from "../../../lib/hello";
import { getUnlockMethod, setUnlockMethod, type UnlockMethod } from "../../../lib/unlockMethod";

export interface VaultUnlockOptions {
  /** Runs once the vault is open (either method). Errors it throws are shown like unlock errors. */
  onUnlocked: () => void | Promise<void>;
  /** An unlock attempt started / failed (`null`: cancelled quietly). Lets a caller mirror the busy state. */
  onStart?: () => void;
  onFail?: (error: string | null) => void;
  /** Around the Windows Hello prompt (the autofill window steps out of always-on-top for it). */
  beforeHello?: () => Promise<void>;
  afterHello?: () => Promise<void>;
}

/**
 * The unlock step shared by the main vault dialog and the autofill prompt window: master password or
 * Windows Hello (offered only when turned on, never auto-triggered). Opens with the method the user
 * unlocked with last time and lets them switch.
 */
export function useVaultUnlock(opts: VaultUnlockOptions) {
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const [password, setPasswordRaw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [helloOn, setHelloOn] = useState(false);
  const [method, setMethodRaw] = useState<UnlockMethod>(getUnlockMethod);
  const showHello = helloOn && method === "hello";

  useEffect(() => {
    let live = true;
    void helloStatus().then((s) => { if (live) setHelloOn(s.enabled); });
    return () => { live = false; };
  }, []);

  const start = () => { setBusy(true); setError(null); optsRef.current.onStart?.(); };
  const fail = (msg: string | null) => { setError(msg); setBusy(false); optsRef.current.onFail?.(msg); };

  const setPassword = (value: string) => { setPasswordRaw(value); setError(null); };
  const setMethod = (m: UnlockMethod) => { setError(null); setMethodRaw(m); };

  const unlockWithPassword = async () => {
    if (busy) return;
    if (!password) { setError("Enter your master password"); return; }
    start();
    try {
      // The same throttled command everywhere: wrong passwords count towards the lockout.
      await vaultUnlock(password);
      setPasswordRaw("");
      if (helloOn) setUnlockMethod("password");
      await optsRef.current.onUnlocked();
    } catch (err) {
      fail(vaultErrorMessage(err));
    }
  };

  const unlockWithHello = async () => {
    if (busy) return;
    start();
    const o = optsRef.current;
    let ok = false;
    try {
      await o.beforeHello?.();
      await helloUnlock();
      ok = true;
    } catch (err) {
      const msg = vaultErrorMessage(err);
      setHelloOn((await helloStatus()).enabled); // a failure may have turned Hello off
      fail(isHelloCancel(msg) ? null : msg);
    } finally {
      // Before `onUnlocked`, so the caller's window is back in place when it continues.
      await o.afterHello?.();
    }
    if (!ok) return;
    setUnlockMethod("hello");
    try { await o.onUnlocked(); } catch (err) { fail(vaultErrorMessage(err)); }
  };

  /** Form submit: Enter unlocks with whichever method is on screen. */
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    void (showHello ? unlockWithHello() : unlockWithPassword());
  };

  return { password, setPassword, busy, error, helloOn, method, setMethod, showHello, unlockWithHello, submit };
}

export type VaultUnlock = ReturnType<typeof useVaultUnlock>;
