import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { KeyRound } from "lucide-react";
import { Dialog, DialogBody, DialogButton, DialogFooter } from "../ui/Dialog";
import { SaveFields } from "./autofillBodies";
import { useVaultStore } from "../../store/vaultStore";
import { vaultErrorMessage } from "../../lib/vault";
import { toast } from "../../lib/toast";
import { nameError } from "../../lib/vaultTree";
import { defaultLoginName, findLogins, isFallbackRequest, planSave, saveLogin, type SavePlan, type SaveRequest } from "../../lib/autofill";

const reply = (id: string, payload: unknown) => invoke("autofill_reply", { id, payload });

/**
 * FALLBACK ONLY. "Save this login?" normally appears in the small autofill window
 * (src/autofill/AutofillPromptApp.tsx); Rust sends the request here, marked `fallback: true`, only when
 * that window can't be created. Every other `autofill:save` is ignored. Nothing is written until the
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
    const un = listen<SaveRequest & { fallback?: boolean }>("autofill:save", async (e) => {
      const r = e.payload;
      if (!isFallbackRequest(r)) return;
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
    // Rust stopped waiting (timeout): close a prompt that is still open for that request.
    const unCancel = listen<{ id: string }>("autofill:cancel", (e) => {
      setReq((cur) => {
        if (!cur || cur.id !== e.payload.id) return cur;
        active.current = false;
        return null;
      });
    });
    return () => { void un.then((f) => f()); void unCancel.then((f) => f()); };
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
        <SaveFields req={req} plan={plan} name={name} onName={setName} nameError={nameErr}
                    reveal={reveal} onReveal={() => setReveal((v) => !v)} onEnter={() => void confirm()} />
      </DialogBody>
      <DialogFooter>
        <DialogButton cancel onClick={() => void deny()}>Not now</DialogButton>
        <DialogButton variant="primary" disabled={busy || !!nameErr} onClick={() => void confirm()}>{update ? "Update" : "Save"}</DialogButton>
      </DialogFooter>
    </Dialog>
  );
}
