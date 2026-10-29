import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Dialog, DialogBody, DialogButton, DialogCheckbox, DialogFooter } from "../ui/Dialog";
import { useVaultStore } from "../../store/vaultStore";
import { toast } from "../../lib/toast";
import {
  clearTrust, credentialsFor, decideTrusted, indexOfAccount, isTrusted, lookalikeWarning, scanLogins, trustHost,
  type LoginMatch,
} from "../../lib/autofill";
import type { Lookalike } from "../../lib/lookalike";

/** `account`: optional vault-relative path the extension asks for (from an earlier `choose` reply). */
interface Req { id: string; host: string; account?: string }

const reply = (id: string, payload: unknown) => invoke("autofill_reply", { id, payload });

/** The page looks like a saved site but isn't one: the reply stays `no_match`; only the user is warned, in the app. */
const warnLookalike = (host: string, l: Lookalike | null) => { if (l) toast.warning(lookalikeWarning(host, l), 12000); };

/**
 * A browser extension asked to fill a login. Nothing is released until the vault is unlocked and the user presses
 * Allow here, or the user allowed this exact site for 5 minutes (then it is answered without a dialog).
 */
export function AutofillPrompt() {
  const [req, setReq] = useState<Req | null>(null);
  const [matches, setMatches] = useState<LoginMatch[]>([]);
  const [pick, setPick] = useState(0);
  const [trust, setTrust] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const un = listen<Req>("autofill:request", async (e) => {
      const r = e.payload;
      const vault = useVaultStore.getState();
      // Trust window: only while the vault is already unlocked; never a dialog, never more than host matches.
      if (vault.unlocked && isTrusted(r.host)) {
        try {
          const scan = await scanLogins(r.host);
          const d = decideTrusted(scan.matches, r.account);
          if (d.kind === "no_match") { await reply(r.id, { error: "no_match" }); warnLookalike(r.host, scan.lookalike); }
          else if (d.kind === "choose") await reply(r.id, { choose: d.options });
          else await reply(r.id, { ok: true, ...(await credentialsFor(d.match)) });
        } catch {
          await reply(r.id, { error: "failed" });
        }
        return;
      }
      if (!vault.unlocked && !(await vault.ensureUnlocked())) {
        await reply(r.id, { error: "locked" });
        return;
      }
      try {
        const { matches: found, lookalike } = await scanLogins(r.host);
        if (!found.length) { await reply(r.id, { error: "no_match" }); warnLookalike(r.host, lookalike); return; }
        setMatches(found); setPick(Math.max(0, indexOfAccount(found, r.account))); setTrust(false); setReq(r);
      } catch {
        await reply(r.id, { error: "failed" });
      }
    });
    // Tell the backend we're listening (an app started by the extension waits for this before emitting).
    void un.then(() => { if (!cancelled) void invoke("autofill_ui_ready").catch(() => {}); });
    // Closing the window to the tray ends every trust window.
    const unHide = listen("vault-window-hidden", () => clearTrust());
    return () => {
      cancelled = true;
      void un.then((f) => f());
      void unHide.then((f) => f());
    };
  }, []);

  // Locking the vault cancels an open prompt and ends every trust window.
  const unlocked = useVaultStore((s) => s.unlocked);
  useEffect(() => {
    if (!unlocked) clearTrust();
    if (!unlocked && req) { void reply(req.id, { error: "locked" }); setReq(null); setMatches([]); }
  }, [unlocked, req]);

  if (!req) return null;

  const done = () => { setReq(null); setMatches([]); setTrust(false); };
  const deny = async () => { await reply(req.id, { error: "denied" }); done(); };
  const allow = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (trust) trustHost(req.host);
      await reply(req.id, { ok: true, ...(await credentialsFor(matches[pick])) });
    } finally { setBusy(false); done(); }
  };

  return (
    // Security prompt raised by another app: Deny holds the initial focus so a stray Enter can't release a login.
    <Dialog onClose={() => void deny()} zClassName="z-[80]" size="sm" role="alertdialog" defaultFocus="cancel"
            title="Fill login in your browser?" icon="shield">
      <DialogBody
        message={<>Your browser is on <strong>{req.host}</strong> and asked for a saved login.</>}
        detail="Only allow this if you just pressed Fill there."
      >
        <div className="flex flex-col gap-1">
          {matches.map((m, i) => (
            <label key={m.path} className="flex items-center gap-2 text-xs px-2 py-1.5 rounded cursor-pointer border border-[var(--color-border)]">
              <input type="radio" name="login" checked={pick === i} onChange={() => setPick(i)} />
              <span className="font-medium">{m.entry.title || m.entry.url}</span>
              <span className="text-[var(--color-text-muted)] truncate">{m.entry.username}</span>
            </label>
          ))}
        </div>
        <DialogCheckbox
          checked={trust}
          onChange={setTrust}
          label={<>Allow <strong>{req.host}</strong> for 5 minutes</>}
          hint="Fills on this exact site without asking until then, while the vault stays unlocked."
        />
      </DialogBody>
      <DialogFooter>
        <DialogButton cancel onClick={() => void deny()}>Deny</DialogButton>
        <DialogButton variant="primary" disabled={busy} onClick={() => void allow()}>Allow</DialogButton>
      </DialogFooter>
    </Dialog>
  );
}
