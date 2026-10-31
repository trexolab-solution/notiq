import { useCallback, useEffect, useRef, useState } from "react";
import { syncConnect, syncErrorMessage, useSyncStore, type SyncStatus } from "../../../lib/vaultSync";

/**
 * Google sign-in for Vault Sync. `sync_connect` opens the browser and waits (up to 180 s) for the
 * sign-in to finish; Cancel only stops waiting in the UI (a late answer is ignored, and the browser
 * sign-in simply times out in the backend).
 */
export function useSyncConnect(onConnected?: (s: SyncStatus) => void) {
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attempt = useRef(0);
  const cb = useRef(onConnected);
  cb.current = onConnected;

  useEffect(() => () => { attempt.current++; }, []); // unmounted: ignore any late answer

  const connect = useCallback(async () => {
    const mine = ++attempt.current;
    setConnecting(true);
    setError(null);
    try {
      const s = await syncConnect();
      if (mine !== attempt.current) return;
      useSyncStore.getState().setStatus(s);
      setConnecting(false);
      cb.current?.(s);
    } catch (e) {
      if (mine !== attempt.current) return;
      setConnecting(false);
      setError(syncErrorMessage(e));
    }
  }, []);

  const cancel = useCallback(() => {
    attempt.current++;
    setConnecting(false);
    setError(null);
  }, []);

  return { connecting, error, connect, cancel };
}

export const WAITING_FOR_GOOGLE = "Waiting for Google sign-in in your browser…";
