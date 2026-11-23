import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "../../../lib/toast";
import type { SshTarget } from "../../../lib/sshConnect";
import { isConnectionError, sftpClose, sftpErrorMessage, sftpList, sftpOpen, sftpTrashList, type RemoteEntry } from "../../../lib/sftp";
import { newSessionId, type Link, type Phase } from "./types";

/**
 * The SFTP session behind a file manager: signing in, the folder shown (path, entries, selection), back / forward
 * history, the Trash count, and reconnecting after the connection dropped. `active` is false while its tab is hidden.
 */
export function useSftpSession(target: SshTarget, active: boolean) {
  const [phase, setPhase] = useState<Phase>("connecting");
  const [failure, setFailure] = useState("");
  const [title, setTitle] = useState(target.title);
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<RemoteEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  /** The connection to the server: fine, being re-established after it dropped, or lost for good (a button retries). */
  const [link, setLink] = useState<Link>("ok");
  const alive = useRef(true);
  const reconnecting = useRef(false);
  const reconnectRef = useRef<() => void>(() => {});
  /** Folders visited before and after this one (back / forward), like a browser. */
  const [nav, setNav] = useState<{ back: string[]; fwd: string[] }>({ back: [], fwd: [] });
  /** Items in the server's Trash (null until known): the Trash button shows empty / not empty. */
  const [trashCount, setTrashCount] = useState<number | null>(null);

  /** The newest target, read inside callbacks. The caller passes a fresh object on every render, so effects must not depend on it. */
  const targetRef = useRef(target);
  targetRef.current = target;
  /** True while an upload or download is running: a quick check of the connection must not tear the session down under it. */
  const busy = useRef(false);
  const sid = useRef(0);
  const anchor = useRef<string | null>(null);
  const pathRef = useRef("");
  pathRef.current = path;

  const load = useCallback(async (want: string, session = sid.current) => {
    setLoading(true);
    try {
      const l = await sftpList(session, want);
      if (session !== sid.current) return;
      setPath(l.path); setEntries(l.entries); setSelected(new Set()); anchor.current = null;
    } catch (e) {
      if (session === sid.current) {
        const m = sftpErrorMessage(e);
        if (isConnectionError(m)) reconnectRef.current(); else toast.error(m);
      }
    } finally {
      if (session === sid.current) setLoading(false);
    }
  }, []);

  const connect = useCallback(async () => {
    const session = newSessionId();
    sid.current = session;
    setPhase("connecting"); setFailure("");
    try {
      const o = await sftpOpen(session, targetRef.current.path, targetRef.current.auth);
      if (session !== sid.current) { void sftpClose(session); return; }
      setTitle(o.title || targetRef.current.title);
      setPhase("ready");
      setNav({ back: [], fwd: [] });
      void sftpTrashList(session).then((l) => { if (session === sid.current) setTrashCount(l.length); }).catch(() => { toast.warning("Couldn't check the trash. Try again.", { id: "sftp-trash-failed" }); });
      await load(o.home, session);
    } catch (e) {
      if (session !== sid.current) return;
      setFailure(sftpErrorMessage(e)); setPhase("failed");
    }
  }, [load]);

  /** Signs in again after the connection dropped (up to three tries), then shows the same folder again. */
  const reconnect = useCallback(async () => {
    if (reconnecting.current || !alive.current) return;
    reconnecting.current = true;
    setLink("reconnecting");
    if (sid.current) void sftpClose(sid.current);
    for (const wait of [0, 1500, 4000]) {
      if (wait) await new Promise((r) => setTimeout(r, wait));
      if (!alive.current) { reconnecting.current = false; return; }
      const session = newSessionId();
      sid.current = session;
      try {
        await sftpOpen(session, targetRef.current.path, targetRef.current.auth);
        if (!alive.current || session !== sid.current) { void sftpClose(session); reconnecting.current = false; return; }
        reconnecting.current = false;
        setLink("ok");
        await load(pathRef.current || ".", session);
        void sftpTrashList(session).then((l) => { if (session === sid.current) setTrashCount(l.length); }).catch(() => { toast.warning("Couldn't check the trash. Try again.", { id: "sftp-trash-failed" }); });
        return;
      } catch { /* try again, or give up below */ }
    }
    reconnecting.current = false;
    if (alive.current) setLink("lost");
  }, [load]);
  reconnectRef.current = () => void reconnect();

  // Coming back to the window (or to this tab) after a while: find out quietly whether the connection survived.
  useEffect(() => {
    if (phase !== "ready" || !active) return;
    let last = 0;
    const probe = () => {
      if (link !== "ok" || busy.current || Date.now() - last < 10_000) return;
      last = Date.now();
      sftpList(sid.current, pathRef.current || ".").catch((e) => { if (!busy.current && isConnectionError(sftpErrorMessage(e))) reconnectRef.current(); });
    };
    window.addEventListener("focus", probe);
    return () => window.removeEventListener("focus", probe);
  }, [phase, active, link]);

  useEffect(() => {
    alive.current = true;
    void connect();
    return () => {
        alive.current = false; const s = sid.current; sid.current = 0; if (s) void sftpClose(s); };
  }, [connect]);

  return {
    phase, failure, title, path, entries, loading, selected, setSelected, link, nav, setNav, trashCount, setTrashCount,
    sid, busy, anchor, pathRef, reconnectRef, load, connect, reconnect,
  };
}
