import React from "react";
import { ChevronDown, FileText } from "lucide-react";
import { Tooltip } from "../../ui/Tooltip";
import { ModelPicker } from "../ModelPicker";
import type { ModelInfo } from "../../../lib/ai/client";
import type { AIProvider, Tab } from "../../../types";
import { ContextFilesPopover } from "./ContextFilesPopover";
import { tabLabel } from "./contextFiles";

interface ChatContextBarProps {
  useNoteContext: boolean;
  onToggleNoteContext: () => void;
  selectedTabs: Tab[];
  noteTabs: Tab[];
  contextTabIds: Set<string>;
  onToggleContextTab: (id: string) => void;
  onSelectAllContext: () => void;
  onClearAllContext: () => void;
  ctxPopoverOpen: boolean;
  onToggleCtxPopover: (e: React.MouseEvent) => void;
  onCloseCtxPopover: () => void;
  ctxPickerBtnRef: React.RefObject<HTMLButtonElement>;
  modelSelectValue: string;
  onModelSelectChange: (v: string) => void;
  loadModelChoices: () => void;
  modelChoices: (ModelInfo & { provider: AIProvider })[] | null;
  modelExtraOptions: { value: string; label: string }[];
}

/**
 * Composer's top row: the note-context toggle pill, its file-picker chevron +
 * popover, and the per-conversation model picker.
 */
export function ChatContextBar({
  useNoteContext, onToggleNoteContext, selectedTabs, noteTabs, contextTabIds,
  onToggleContextTab, onSelectAllContext, onClearAllContext,
  ctxPopoverOpen, onToggleCtxPopover, onCloseCtxPopover, ctxPickerBtnRef,
  modelSelectValue, onModelSelectChange, loadModelChoices, modelChoices, modelExtraOptions,
}: ChatContextBarProps) {
  return (
    <div className="ai-chat__context-row">
      <Tooltip content={useNoteContext ? "Sharing selected files as context — click to turn off" : "Note context is off — click to turn on"}>
        <button
          type="button"
          className={`ai-chat__context-pill${useNoteContext ? " is-on" : ""}`}
          onClick={onToggleNoteContext}
        >
          <FileText size={12} />
          <span className="ai-chat__context-label">
            {!useNoteContext
              ? "Note context off"
              : selectedTabs.length === 0
                ? "No files selected"
                : selectedTabs.length === 1
                  ? `Using: ${tabLabel(selectedTabs[0])}`
                  : `Using: ${selectedTabs.length} files`}
          </span>
        </button>
      </Tooltip>
      {useNoteContext && (
        <Tooltip content="Choose which open files to include">
          <button
            type="button"
            ref={ctxPickerBtnRef}
            className={`ai-chat__ctx-picker-btn${ctxPopoverOpen ? " is-active" : ""}`}
            aria-label="Choose context files"
            onClick={onToggleCtxPopover}
          >
            <ChevronDown size={11} />
          </button>
        </Tooltip>
      )}
      {ctxPopoverOpen && (
        <ContextFilesPopover
          tabs={noteTabs}
          selected={contextTabIds}
          onToggle={onToggleContextTab}
          onSelectAll={onSelectAllContext}
          onClearAll={onClearAllContext}
          onClose={onCloseCtxPopover}
          anchorRef={ctxPickerBtnRef}
        />
      )}

      <ModelPicker
        variant="pill"
        unified
        value={modelSelectValue}
        onChange={onModelSelectChange}
        onOpen={loadModelChoices}
        models={modelChoices ?? []}
        extraOptions={modelExtraOptions}
        aria-label="Model for this chat"
      />
    </div>
  );
}
