import { useCallback, useState } from "react";
import type { ReactNode } from "react";
import { SshAuthChoiceDialog } from "../../terminal/SshAuthChoiceDialog";
import { useVaultStore } from "../../../store/vaultStore";
import { vaultErrorMessage, vaultReadFile } from "../../../lib/vault";
import { parseSecret } from "../../../lib/secretEntry";
import { sshLabel, sshMethods, type SshTarget } from "../../../lib/sshConnect";
import { requestSshSession } from "../../../lib/sshTerminalRequest";
import { toast } from "../../../lib/toast";
import type { SshAuth } from "../../../lib/sshEntry";

/**
 * "Open in terminal" for a saved SSH entry picked in the vault tree: reads the entry (the vault must be
 * unlocked), starts the session straight away when it has one sign-in method, and asks which one to use
 * when it has both a private key and a password. Render `dialog` somewhere in the tree.
 * `start` says where the chosen server goes: the terminal (default) or the file manager.
 */
export function useOpenSshInTerminal(root: string, start: (t: SshTarget) => void = requestSshSession): { open: (rel: string) => Promise<void>; dialog: ReactNode } {
  const [choice, setChoice] = useState<{ path: string; name: string; label: string } | null>(null);

  const open = useCallback(async (rel: string) => {
    if (!(await useVaultStore.getState().ensureUnlocked())) return;
    try {
      const path = `${root}/${rel}`;
      const entry = parseSecret("ssh", (await vaultReadFile(path)).content);
      const name = entry.title.trim() || rel.replace(/\.nqv$/i, "").split("/").pop() || rel;
      const label = sshLabel(entry.fields);
      if (!label) { toast.error(`“${name}” has no host saved yet`); return; }
      const methods = sshMethods(entry.fields);
      if (methods.length === 0) { toast.error(`“${name}” has no private key or password saved`); return; }
      if (methods.length === 1) { start({ path, auth: methods[0], title: name }); return; }
      setChoice({ path, name, label });
    } catch (e) {
      toast.error(vaultErrorMessage(e));
    }
  }, [root, start]);

  const pick = (auth: SshAuth) => {
    if (!choice) return;
    const target: SshTarget = { path: choice.path, auth, title: choice.name };
    setChoice(null);
    start(target);
  };

  const dialog = choice
    ? <SshAuthChoiceDialog name={choice.name} label={choice.label} onPick={pick} onClose={() => setChoice(null)} />
    : null;
  return { open, dialog };
}
