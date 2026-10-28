import { FileText, Folder, FolderOpen, KeyRound, KeySquare, Server } from "lucide-react";
import type { EntryKind } from "../../../lib/vaultTree";

const LABEL: Record<EntryKind, string> = {
  folder: "Folder", note: "Secure note", login: "Login", ssh: "SSH / server", secret: "API key / secret",
};
export const kindLabel = (k: EntryKind) => LABEL[k];

/** Icon for a vault entry type, tinted per kind (see .vt-row-icon.k-* in vault.css). */
export function EntryIcon({ kind, open = false, size = 14 }: { kind: EntryKind; open?: boolean; size?: number }) {
  const cls = `vt-row-icon k-${kind}`;
  const p = { size, className: cls, strokeWidth: 1.9, "aria-hidden": true } as const;
  switch (kind) {
    case "folder": return open ? <FolderOpen {...p} /> : <Folder {...p} />;
    case "login":  return <KeyRound {...p} />;
    case "ssh":    return <Server {...p} />;
    case "secret": return <KeySquare {...p} />;
    default:       return <FileText {...p} />;
  }
}
