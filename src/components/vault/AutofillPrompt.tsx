import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ShieldCheck } from "lucide-react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
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
    <Modal onClose={() => void deny()} zClassName="z-[80]">
      <div className="w-[400px] max-w-[92vw] rounded-xl p-5 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] shadow-2xl text-[var(--color-text)]"
           role="dialog" aria-modal="true" aria-label="Allow autofill">
        <div className="flex items-center gap-2 mb-2">
          <ShieldCheck size={18} style={{ color: "var(--color-primary)" }} />
          <h2 className="text-sm font-semibold">Fill login in your browser?</h2>
        </div>
        <p className="text-xs mb-3 text-[var(--color-text-muted)]">
          Your browser is on <strong className="text-[var(--color-text)]">{req.host}</strong> and asked for a saved login.
          Only allow this if you just pressed Fill there.
        </p>
        <div className="flex flex-col gap-1 mb-3">
          {matches.map((m, i) => (
            <label key={m.path} className="flex items-center gap-2 text-xs px-2 py-1.5 rounded cursor-pointer border border-[var(--color-border)]">
              <input type="radio" name="login" checked={pick === i} onChange={() => setPick(i)} />
              <span className="font-medium">{m.entry.title || m.entry.url}</span>
              <span className="text-[var(--color-text-muted)] truncate">{m.entry.username}</span>
            </label>
          ))}
        </div>
        <label className="flex items-center gap-2 text-xs mb-4 cursor-pointer text-[var(--color-text-muted)]">
          <input type="checkbox" checked={trust} onChange={(e) => setTrust(e.target.checked)} />
          <span>
            Allow <strong className="text-[var(--color-text)]">{req.host}</strong> for 5 minutes
            <span className="block opacity-80">Fills on this exact site without asking until then, while the vault stays unlocked.</span>
          </span>
        </label>
        <div className="flex gap-2 justify-end">
          <Button onClick={() => void deny()}>Deny</Button>
          <Button variant="primary" disabled={busy} onClick={() => void allow()}>Allow</Button>
        </div>
      </div>
    </Modal>
  );
}
