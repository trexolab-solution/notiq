import { useEffect, useState } from "react";
import { Server } from "lucide-react";
import { Dialog, DialogBody, DialogFooter, DialogButton, DialogText } from "../ui/Dialog";
import { SshAuthChoiceDialog } from "./SshAuthChoiceDialog";
import { useVaultStore } from "../../store/vaultStore";
import { vaultList, vaultReadFile, vaultErrorMessage } from "../../lib/vault";
import { vaultRoot } from "../../lib/autofill";
import { parseSecret } from "../../lib/secretEntry";
import { sshMethods, sshLabel, isConnectable, type SshTarget } from "../../lib/sshConnect";
import type { SshAuth } from "../../lib/sshEntry";

interface Row { path: string; name: string; label: string; fields: Record<string, string>; methods: SshAuth[] }

interface Props {
  onConnect: (target: SshTarget) => void;
  onClose:   () => void;
}

const rowBtn =
  "w-full text-left px-3 py-2 rounded-md border border-[var(--color-border)] cursor-pointer " +
  "hover:border-[var(--color-primary)] hover:bg-[var(--color-bg-tertiary)] " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)]";

/**
 * Picks a saved vault SSH entry and, when it holds both a private key and a password,
 * asks which one to sign in with. Only the entry's path leaves this dialog; the backend reads the secrets.
 */
export function SshConnectDialog({ onConnect, onClose }: Props) {
  const [rows, setRows]       = useState<Row[] | null>(null);
  const [error, setError]     = useState("");
  /** Entries left out because they lack a host, a user name or a key / password. */
  const [incomplete, setIncomplete] = useState(0);
  const [choosing, setChoose] = useState<Row | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      if (!(await useVaultStore.getState().ensureUnlocked())) { if (live) onClose(); return; }
      const root = await vaultRoot();
      const items = (await vaultList()).filter((i) => !i.dir && i.ext === "ssh" && i.trashed_at == null);
      const out: Row[] = [];
      let skipped = 0;
      for (const i of items) {
        try {
          const path = `${root}/${i.rel}`;
          const f = await vaultReadFile(path);
          const e = parseSecret("ssh", f.content);
          const name = e.title.trim() || i.rel.replace(/\.nqv$/i, "").split("/").pop() || i.rel;
          if (!isConnectable(e.fields)) { skipped++; continue; } // only complete servers are listed
          out.push({ path, name, label: sshLabel(e.fields), fields: e.fields, methods: sshMethods(e.fields) });
        } catch { /* one unreadable entry shouldn't hide the others */ }
      }
      out.sort((a, b) => a.name.localeCompare(b.name));
      if (live) { setRows(out); setIncomplete(skipped); }
    })().catch((e) => { if (live) { setError(vaultErrorMessage(e)); setRows([]); } });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once when the dialog opens
  }, []);

  const connect = (row: Row, auth: SshAuth) => onConnect({ path: row.path, auth, title: row.name });

  const pick = (row: Row) => {
    setError("");
    if (!row.label) { setError(`“${row.name}” has no host saved yet.`); return; }
    if (row.methods.length === 0) { setError(`“${row.name}” has no private key or password saved.`); return; }
    if (row.methods.length === 1) { connect(row, row.methods[0]); return; }
    setChoose(row);
  };

  if (choosing) {
    return (
      <SshAuthChoiceDialog name={choosing.name} label={choosing.label} onPick={(auth) => connect(choosing, auth)}
                           onClose={onClose} cancelLabel="Back" onCancel={() => setChoose(null)} />
    );
  }

  return (
    <Dialog title="Connect to a server" icon={<Server size={16} />} size="sm" onClose={onClose}>
      <DialogBody>
        {rows === null && <DialogText>Loading your saved servers…</DialogText>}
        {rows !== null && rows.length === 0 && !error && (
          <DialogText>
            {incomplete > 0
              ? "No complete servers yet. A server needs a host, a user name and a private key or password."
              : "No SSH / server entries in your vault yet. Add one in the vault first."}
          </DialogText>
        )}
        {rows !== null && rows.length > 0 && (
          <div className="flex flex-col gap-2" role="list">
            {rows.map((r) => (
              <button key={r.path} role="listitem" className={rowBtn} onClick={() => pick(r)}>
                <div className="text-sm">{r.name}</div>
                <div className="text-xs text-[var(--color-text-muted)]">
                  {r.label || "No host saved"}
                  {r.methods.length > 0 && ` · ${r.methods.map((m) => (m === "key" ? "key" : "password")).join(" + ")}`}
                </div>
              </button>
            ))}
          </div>
        )}
        {rows !== null && rows.length > 0 && incomplete > 0 && (
          <p className="text-[11px] mt-3 text-[var(--color-text-muted)]">
            {incomplete} incomplete {incomplete === 1 ? "entry is" : "entries are"} hidden (needs a host, a user name and a key or password).
          </p>
        )}
        {error && <p className="text-xs mt-3 text-[var(--color-danger,#e5534b)]" role="alert">{error}</p>}
      </DialogBody>
      <DialogFooter>
        <DialogButton cancel onClick={onClose}>Cancel</DialogButton>
      </DialogFooter>
    </Dialog>
  );
}
