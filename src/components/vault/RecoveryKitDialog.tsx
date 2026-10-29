import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { FileDown, Printer } from "lucide-react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { toast } from "../../lib/toast";
import { buildRecoveryKitHtml } from "../../lib/recoveryKit";
import { nativePrint } from "../../lib/pdfExport";

/** Same off-screen root print.css reveals (and hides everything else) when printing. */
const PRINT_ROOT_ID = "notiq-print-root";
/** The native silent print-to-PDF (`export_pdf`) is implemented on Windows only. */
const CAN_SAVE_PDF = typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);

const nextFrames = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

/**
 * Preview + print of the recovery kit. Shown only from the recovery-key step right after the
 * vault is created. The key lives in this component's memory only: nothing is persisted or
 * logged, and the printable copy is removed from the page when the dialog closes.
 */
export function RecoveryKitDialog({ recoveryKey, onClose }: { recoveryKey: string; onClose: () => void }) {
  const [fingerprint, setFingerprint] = useState("");
  const [busy, setBusy] = useState(false);
  const roots = useRef<HTMLElement[]>([]);
  const createdAt = useMemo(() => new Date(), []);

  useEffect(() => {
    invoke<string>("vault_fingerprint").then(setFingerprint).catch(() => setFingerprint(""));
  }, []);

  const html = useMemo(
    () => buildRecoveryKitHtml({ recoveryKey, fingerprint, createdAt }),
    [recoveryKey, fingerprint, createdAt],
  );

  const unmountAll = () => {
    roots.current.forEach((el) => { el.innerHTML = ""; el.remove(); });
    roots.current = [];
  };
  // Clear the printable copy whenever the dialog goes away.
  useEffect(() => unmountAll, []);

  const mountPrintRoot = (): (() => void) => {
    unmountAll();
    document.getElementById(PRINT_ROOT_ID)?.remove();
    const el = document.createElement("div");
    el.id = PRINT_ROOT_ID;
    el.innerHTML = html; // built from escaped values only
    document.body.appendChild(el);
    roots.current.push(el);
    return () => {
      el.innerHTML = "";
      el.remove();
      roots.current = roots.current.filter((r) => r !== el);
    };
  };

  const print = () => {
    const remove = mountPrintRoot();
    const done = () => { window.removeEventListener("afterprint", done); remove(); };
    window.addEventListener("afterprint", done);
    window.print();
  };

  const savePdf = async () => {
    if (busy) return;
    const path = await save({
      title: "Save recovery kit as PDF",
      defaultPath: "Notiq recovery kit.pdf",
      filters: [{ name: "PDF Document", extensions: ["pdf"] }],
    });
    if (!path) return;
    setBusy(true);
    const remove = mountPrintRoot();
    try {
      await nextFrames();
      const res = await nativePrint(path);
      if (!res.success) throw new Error(res.error || "PDF export failed");
      toast.warning("Saved. The PDF is not encrypted: print it or move it to offline storage, then delete other copies.");
    } catch {
      toast.error("Couldn't save the PDF");
    } finally {
      remove();
      setBusy(false);
    }
  };

  const close = () => { unmountAll(); onClose(); };

  return (
    <Modal onClose={close} zClassName="z-[80]">
      <div
        className="w-[760px] max-w-[94vw] max-h-[92vh] flex flex-col rounded-xl p-5 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] shadow-2xl text-[var(--color-text)]"
        role="dialog" aria-modal="true" aria-label="Recovery kit"
      >
        <h2 className="text-sm font-semibold mb-1">Print your recovery kit</h2>
        <p className="text-xs mb-3 text-[var(--color-text-muted)]">
          A one-page sheet with your recovery key and what to do with it. Print it and keep it somewhere safe and offline.
        </p>
        <div
          className="flex-1 min-h-0 overflow-auto rounded-md border border-[var(--color-border)] bg-white p-6 mb-4"
          data-testid="recovery-kit-preview"
          dangerouslySetInnerHTML={{ __html: html }}
        />
        <div className="flex items-center justify-end gap-2">
          {CAN_SAVE_PDF && (
            <Button icon={<FileDown size={12} />} disabled={busy} onClick={() => void savePdf()}>
              {busy ? "Saving…" : "Save as PDF…"}
            </Button>
          )}
          <Button variant="primary" icon={<Printer size={12} />} disabled={busy} onClick={print}>Print…</Button>
          <Button onClick={close}>Close</Button>
        </div>
      </div>
    </Modal>
  );
}
