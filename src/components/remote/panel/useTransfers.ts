import { useEffect, useState, type MutableRefObject } from "react";
import type { Transfer } from "../RemoteTransfers";
import {
  isConnectionError, onSftpProgress, sftpErrorMessage, SFTP_CANCELLED, SFTP_EXISTS, SFTP_EXISTS_DIR, type MergeMode,
} from "../../../lib/sftp";
import type { ReplaceAsk } from "./ConflictDialogs";
import { newTransferId, type Conflict } from "./types";

type Run = (id: number, overwrite: boolean, merge?: MergeMode) => Promise<number>;

/**
 * The uploads and downloads list, with progress, and the "replace it?" question a transfer asks when its target exists.
 * A lost connection calls `reconnectRef`.
 */
export function useTransfers(reconnectRef: MutableRefObject<() => void>) {
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [replace, setReplace] = useState<ReplaceAsk | null>(null);

  // Progress events carry the transfer id; the list shows the latest of each.
  useEffect(() => {
    let off: (() => void) | undefined;
    let dead = false;
    void onSftpProgress((p) => setTransfers((ts) => ts.map((t) => (t.id === p.transfer && t.state === "running" ? { ...t, done: p.done, total: p.total } : t))))
      .then((u) => { if (dead) u(); else off = u; });
    return () => { dead = true; off?.(); };
  }, []);

  const track = (t: Transfer) => setTransfers((ts) => [...ts, t]);
  const finish = (id: number, patch: Partial<Transfer>) => setTransfers((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  const askReplace = (name: string, folder: boolean) => new Promise<Conflict>((resolve) => setReplace({ name, folder, answer: resolve }));

  /**
   * One transfer: runs it; when the target exists asks what to do (replace; for a folder also keep the files that are
   * already there), then runs it again. A lost connection starts the reconnect.
   */
  const runTransfer = async (kind: "up" | "down", name: string, run: Run) => {
    const id = newTransferId();
    track({ id, kind, name, done: 0, total: 0, state: "running" });
    const fail = (e: unknown) => {
      const m = sftpErrorMessage(e);
      if (m === SFTP_CANCELLED) { finish(id, { state: "cancelled" }); return; }
      finish(id, { state: "error", error: m });
      if (isConnectionError(m)) reconnectRef.current();
    };
    try {
      await run(id, false);
      finish(id, { state: "done" });
    } catch (e) {
      const msg = sftpErrorMessage(e);
      if (msg === SFTP_EXISTS || msg === SFTP_EXISTS_DIR) {
        const c = await askReplace(name, msg === SFTP_EXISTS_DIR);
        if (c === "cancel") { finish(id, { state: "skipped" }); return; }
        try { await run(id, true, c === "skip-matching" ? "skip" : "replace"); finish(id, { state: "done" }); }
        catch (e2) { fail(e2); }
        return;
      }
      fail(e);
    }
  };

  /** Clears the finished transfers from the list. */
  const clearFinished = () => setTransfers((ts) => ts.filter((t) => t.state === "running"));

  return { transfers, runTransfer, clearFinished, replace, setReplace };
}
