import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Eye, EyeOff, KeyRound } from "lucide-react";
import { Dialog, DialogBody, DialogButton, DialogFooter } from "../ui/Dialog";
import { Input } from "../ui/Input";
import { useVaultStore } from "../../store/vaultStore";
import { vaultErrorMessage } from "../../lib/vault";
import { toast } from "../../lib/toast";
import { nameError } from "../../lib/vaultTree";
import { defaultLoginName, findLogins, LOGINS_FOLDER, planSave, saveLogin, type SavePlan, type SaveRequest } from "../../lib/autofill";

const reply = (id: string, payload: unknown) => invoke("autofill_reply", { id, payload });

/**
 * A browser extension offered a login it captured. Nothing is written until the
 * vault is unlocked and the user presses Save / Update here.
 */
export function AutofillSavePrompt() {
  const [req, setReq] = useState<SaveRequest | null>(null);
  const [plan, setPlan] = useState<SavePlan | null>(null);
  const [name, setName] = useState("");
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  // True from the moment a request is accepted until it is answered (one prompt at a time).
  const active = useRef(false);

  useEffect(() => {
    const un = listen<SaveRequest>("autofill:save", async (e) => {
      const r = e.payload;
      if (active.current) { await reply(r.id, { error: "denied" }); return; }
      active.current = true;
      try {
        if (!useVaultStore.getState().unlocked && !(await useVaultStore.getState().ensureUnlocked())) {
          await reply(r.id, { error: "locked" });
          active.current = false;
          return;
        }
        const p = planSave(await findLogins(r.host), r);
        if (p.kind === "unchanged") {
          await reply(r.id, { ok: true, status: "unchanged" });
          active.current = false;
          return;
        }
        setPlan(p); setName(defaultLoginName(r.title, r.host)); setReveal(false); setReq(r);
      } catch {
        await reply(r.id, { error: "failed" });
        active.current = false;
      }
    });
    return () => { void un.then((f) => f()); };
  }, []);

  const close = () => { setReq(null); setPlan(null); setReveal(false); active.current = false; };

  // Locking the vault while the prompt is open cancels it.
  const unlocked = useVaultStore((s) => s.unlocked);
  useEffect(() => {
    if (!unlocked && req) { void reply(req.id, { error: "locked" }); close(); }
  }, [unlocked, req]);

  if (!req || !plan) return null;

  const update = plan.kind === "update";
  const nameErr = update ? null : nameError(name);
  const deny = async () => { if (busy) return; await reply(req.id, { error: "denied" }); close(); };
  const confirm = async () => {
    if (busy || nameErr) return;
    setBusy(true);
    try {
      const status = await saveLogin(plan, req, name);
      await reply(req.id, { ok: true, status });
    } catch (e) {
      toast.error(vaultErrorMessage(e));
      await reply(req.id, { error: "failed" });
    } finally {
      setBusy(false);
      close();
    }
  };

  return (
    <Dialog onClose={() => void deny()} zClassName="z-[80]" size="sm"
            title={update ? "Update the saved password?" : "Save this login to Notiq?"} icon={<KeyRound size={16} />}>
      <DialogBody
        message={<>Your browser captured a login on <strong>{req.host}</strong>.</>}
        detail="Only save it if you just signed in there."
      >
        <dl className="text-xs grid grid-cols-[72px_1fr] gap-y-2 gap-x-2 items-center">
          <dt className="text-[var(--color-text-muted)]">Website</dt>
          <dd className="truncate">{req.host}</dd>
          <dt className="text-[var(--color-text-muted)]">Username</dt>
          <dd className="truncate">{req.username || <span className="text-[var(--color-text-muted)]">(none)</span>}</dd>
          <dt className="text-[var(--color-text-muted)]">Password</dt>
          <dd className="flex items-center gap-1 min-w-0">
            <span className="truncate font-mono">{reveal ? req.password : "•".repeat(Math.min(req.password.length, 16))}</span>
            <button type="button" className="p-1 rounded hover:bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)]"
                    aria-label={reveal ? "Hide password" : "Show password"} onClick={() => setReveal((v) => !v)}>
              {reveal ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </dd>
          {!update && (
            <>
              <dt className="text-[var(--color-text-muted)]">Name</dt>
              <dd>
                <Input value={name} maxLength={120} autoFocus aria-label="Name" aria-invalid={!!nameErr}
                       onChange={(e) => setName(e.target.value)}
                       onKeyDown={(e) => { if (e.key === "Enter") void confirm(); }} />
              </dd>
              <dt className="text-[var(--color-text-muted)]">Folder</dt>
              <dd>{LOGINS_FOLDER}</dd>
            </>
          )}
        </dl>
        {update && (
          <p className="text-xs mt-3 text-[var(--color-text-muted)]">
            Updates the password of &ldquo;{plan.target?.entry.title || plan.target?.entry.url}&rdquo;. Other fields stay as they are.
          </p>
        )}
      </DialogBody>
      <DialogFooter>
        <DialogButton cancel onClick={() => void deny()}>Not now</DialogButton>
        <DialogButton variant="primary" disabled={busy || !!nameErr} onClick={() => void confirm()}>{update ? "Update" : "Save"}</DialogButton>
      </DialogFooter>
    </Dialog>
  );
}
