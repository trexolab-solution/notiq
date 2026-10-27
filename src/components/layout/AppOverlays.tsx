import { lazy, Suspense } from "react";

import { ContextMenu } from "../ui/ContextMenu";
import { CommandPalette, type Command } from "../ui/CommandPalette";
import { GlobalSearch } from "../ui/GlobalSearch";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { SettingsModal } from "../ui/SettingsModal";
import { UpdateDialog } from "../ui/UpdateDialog";
import { FileSelectionModal } from "../ui/FileSelectionModal";
import { ToastProvider } from "../ui/Toast";
import { VaultDialog } from "../vault/VaultDialog";
import { AutofillPrompt } from "../vault/AutofillPrompt";
import { VaultDestinationDialog } from "../vault/VaultDestinationDialog";
import { LegacyVaultImport } from "../vault/LegacyVaultImport";

import type { CtxMenuState } from "../../hooks/useGlobalContextMenu";
import type { Tab, AppView } from "../../types";
import type { FileEntry } from "../../lib/fileOps";

const AIOnboarding = lazy(() =>
  import("../ai/AIOnboarding").then((m) => ({ default: m.AIOnboarding }))
);
const Tour = lazy(() => import("../tour/Tour"));

interface Props {
  ctxMenu:               CtxMenuState | null;
  closeCtxMenu:          () => void;

  showSettings:          boolean;
  setShowSettings:       (show: boolean) => void;
  settingsSection:       "ai" | "vault" | undefined;
  setSettingsSection:    (section: "ai" | "vault" | undefined) => void;

  showAIOnboarding:      boolean;
  setShowAIOnboarding:   (show: boolean) => void;

  showTour:              boolean;
  setShowTour:           (show: boolean) => void;

  showPalette:           boolean;
  setShowPalette:        (show: boolean) => void;
  buildCommands:         () => Command[];

  showSearch:            boolean;
  setShowSearch:         (show: boolean) => void;
  tabs:                  Tab[];
  navigateToNote:        (tabId: string, searchText?: string, line?: number) => void;

  fileSelection:         { files: FileEntry[]; folderPath?: string } | null;
  setFileSelection:      (sel: { files: FileEntry[]; folderPath?: string } | null) => void;
  openFilesAsTabs:       (files: FileEntry[]) => void;
  setGraphMounted:       (mounted: boolean) => void;
  setActiveView:         (view: AppView) => void;

  pendingTab:            Tab | null;
  handleSaveAndClose:    () => Promise<void>;
  handleDiscardAndClose: () => void;
  handleCancelClose:     () => void;

  dragOver:              boolean;
}

/**
 * Every top-level overlay/modal App can show: the shared context menu,
 * Settings, AI onboarding, the first-run tour, command palette, global
 * search, the file-selection modal, close-tab confirmation dialogs, the
 * update dialog, toast host, and the drag-and-drop overlay. Extracted from
 * App — purely presentational, all state lives in App and is threaded
 * through as props.
 */
export function AppOverlays({
  ctxMenu, closeCtxMenu,
  showSettings, setShowSettings, settingsSection, setSettingsSection,
  showAIOnboarding, setShowAIOnboarding,
  showTour, setShowTour,
  showPalette, setShowPalette, buildCommands,
  showSearch, setShowSearch, tabs, navigateToNote,
  fileSelection, setFileSelection, openFilesAsTabs, setGraphMounted, setActiveView,
  pendingTab, handleSaveAndClose, handleDiscardAndClose, handleCancelClose,
  dragOver,
}: Props) {
  return (
    <>
      {ctxMenu && (
        <ContextMenu x={ctxMenu.x} y={ctxMenu.y} items={ctxMenu.items} onClose={closeCtxMenu} />
      )}

      {showSettings && (
        <SettingsModal
          onClose={() => { setShowSettings(false); setSettingsSection(undefined); }}
          initialSection={settingsSection}
          onRunAIOnboarding={() => {
            setShowSettings(false);
            setSettingsSection(undefined);
            setShowAIOnboarding(true);
          }}
        />
      )}

      {showAIOnboarding && (
        <Suspense fallback={null}>
          <AIOnboarding onClose={() => setShowAIOnboarding(false)} />
        </Suspense>
      )}

      {showTour && (
        <Suspense fallback={null}>
          <Tour onClose={() => setShowTour(false)} />
        </Suspense>
      )}

      {showPalette && (
        <CommandPalette commands={buildCommands()} onClose={() => setShowPalette(false)} />
      )}

      {showSearch && (
        <GlobalSearch
          tabs={tabs}
          onJump={(tabId, query, line) => navigateToNote(tabId, query, line)}
          onClose={() => setShowSearch(false)}
        />
      )}

      {fileSelection && (
        <FileSelectionModal
          files={fileSelection.files}
          folderPath={fileSelection.folderPath}
          onConfirm={(selected) => {
            setFileSelection(null);
            openFilesAsTabs(selected);
            // Auto-switch to graph view so the user sees the knowledge graph populate
            if (selected.length >= 2) {
              setGraphMounted(true);
              setActiveView("graph");
            }
          }}
          onCancel={() => setFileSelection(null)}
        />
      )}

      {pendingTab && (
        pendingTab.kind === "whiteboard" ? (
          <ConfirmDialog
            title="Close whiteboard?"
            message="This whiteboard has drawings. Closing the tab will permanently delete the canvas data."
            detail={pendingTab.title}
            icon="whiteboard"
            confirmLabel="Discard & Close"
            danger
            onConfirm={handleDiscardAndClose}
            onCancel={handleCancelClose}
          />
        ) : (
          <ConfirmDialog
            title="Unsaved changes"
            message={
              pendingTab.filePath
                ? "This note has unsaved changes. Save before closing?"
                : "This note has never been saved to disk. Close without saving?"
            }
            detail={pendingTab.title}
            icon="file"
            confirmLabel={pendingTab.filePath ? "Save" : "Save As"}
            discardLabel="Discard"
            cancelLabel="Cancel"
            onConfirm={handleSaveAndClose}
            onDiscard={handleDiscardAndClose}
            onCancel={handleCancelClose}
          />
        )
      )}

      <UpdateDialog />

      <VaultDialog />
      <AutofillPrompt />
      <VaultDestinationDialog />
      <LegacyVaultImport />

      <ToastProvider />

      {/* Drag-and-drop overlay */}
      {dragOver && (
        <div className="drop-overlay">
          <div className="drop-overlay-label">Drop files to open</div>
        </div>
      )}
    </>
  );
}
