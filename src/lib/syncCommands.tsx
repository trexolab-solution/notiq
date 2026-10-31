import { Cloud, RefreshCw, Settings as SettingsIcon } from "lucide-react";
import type { Command } from "../components/ui/CommandPalette";
import type { SyncStatus } from "./vaultSync";
import { syncCommandAvailability } from "./syncSurfaces";

export interface SyncCommandHandlers {
  syncNow: () => void;
  openSettings: () => void;
  connect: () => void;
}

/** The "Vault: …" sync commands the palette offers for this state (only the applicable ones). */
export function buildSyncCommands(
  status: SyncStatus | null, vault: { exists: boolean; unlocked: boolean }, h: SyncCommandHandlers,
): Command[] {
  const can = syncCommandAvailability(status, vault);
  const cmds: Command[] = [];
  if (can.syncNow) cmds.push({ id: "vault:sync-now", label: "Vault: Sync now", group: "Vault", icon: <RefreshCw size={14} />, run: h.syncNow });
  if (can.connect) cmds.push({ id: "vault:sync-connect", label: "Vault: Connect Google Drive", group: "Vault", icon: <Cloud size={14} />, run: h.connect });
  if (can.settings) cmds.push({ id: "vault:sync-settings", label: "Vault: Sync settings", group: "Vault", icon: <SettingsIcon size={14} />, run: h.openSettings });
  return cmds;
}
