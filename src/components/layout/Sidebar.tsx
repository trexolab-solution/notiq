import React, { useEffect, useState } from "react";
import { Settings, PenTool, Lock } from "lucide-react";
import { VaultPanel } from "../vault/VaultPanel";
import { useAppStore } from "../../store";
import { Tooltip } from "../ui/Tooltip";
import { useSyncMarkersStore } from "../../lib/syncMarkers";

interface SidebarProps {
  onNewWhiteboard: () => void;
}

export const Sidebar = React.memo(function Sidebar({ onNewWhiteboard }: SidebarProps) {
  const tabs         = useAppStore((s) => s.tabs);
  const activeTabId  = useAppStore((s) => s.activeTabId);
  const openSettings = useAppStore((s) => s.openSettings);
  const [vaultOpen, setVaultOpen] = useState(false);
  // "Review" on a sync result opens the vault panel on its Recently synced view.
  const reviewRequest = useSyncMarkersStore((s) => s.reviewRequest);
  useEffect(() => { if (reviewRequest > 0) setVaultOpen(true); }, [reviewRequest]);
  // Ctrl+B shows / hides the side panel (like VS Code). In the code editor Ctrl+B is Bold, so there it only
  // toggles with Ctrl+Shift+B, which works from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.key.toLowerCase() !== "b") return;
      const inEditor = e.target instanceof Element && !!e.target.closest(".monaco-editor");
      if (inEditor && !e.shiftKey) return;
      e.preventDefault();
      setVaultOpen((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const activeKind   = tabs.find((t) => t.id === activeTabId)?.kind;
  const isWbActive   = activeKind === "whiteboard";
  const isSettingsActive = activeKind === "settings";

  return (
    <aside style={{ display: "flex", height: "100%", flexShrink: 0 }}>
      <div className="activity-bar" data-tour="nav-rail">
        <Tooltip content="Whiteboard" shortcut="Ctrl+3" placement="right">
          <button
            className={`activity-btn${isWbActive ? " is-active" : ""}`}
            aria-label="Whiteboard"
            onClick={onNewWhiteboard}
          >
            <PenTool size={17} strokeWidth={1.8} />
          </button>
        </Tooltip>

        <Tooltip content="Secure Vault" shortcut="Ctrl+B" placement="right">
          <button
            className={`activity-btn${vaultOpen ? " is-active" : ""}`}
            aria-label="Secure Vault"
            aria-pressed={vaultOpen}
            onClick={() => setVaultOpen((v) => !v)}
          >
            <Lock size={16} strokeWidth={1.8} />
          </button>
        </Tooltip>

        <div style={{ flex: 1 }} />

        <Tooltip content="Settings" shortcut="Ctrl+," placement="right">
          <button
            className={`activity-btn${isSettingsActive ? " is-active" : ""}`}
            aria-label="Settings"
            aria-current={isSettingsActive ? "page" : undefined}
            data-tour="settings"
            onClick={() => openSettings()}
          >
            <Settings size={15} strokeWidth={1.8} />
          </button>
        </Tooltip>
      </div>
      {vaultOpen && <VaultPanel />}
    </aside>
  );
});
