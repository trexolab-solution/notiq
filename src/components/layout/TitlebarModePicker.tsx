import { Code2, Columns2, Eye } from "lucide-react";
import { Tooltip } from "../ui/Tooltip";
import { useAppStore } from "../../store";
import type { EditorMode, Tab } from "../../types";

export const MODES: { id: EditorMode; label: string; icon: React.ReactNode }[] = [
  { id: "markdown", label: "Source",  icon: <Code2    size={12} strokeWidth={1.8} /> },
  { id: "preview",  label: "Preview", icon: <Eye      size={12} strokeWidth={1.8} /> },
  { id: "split",    label: "Split",   icon: <Columns2 size={12} strokeWidth={1.8} /> },
];

export function TitlebarModePicker({ tab }: { tab: Tab }) {
  const updateTabEditorMode = useAppStore((s) => s.updateTabEditorMode);

  return (
    <div className="titlebar-mode-slot">
      <div className="mode-picker mode-picker--titlebar">
        {MODES.map((m) => (
          <Tooltip key={m.id} content={m.label}>
            <button
              className={`mode-btn${tab.editorMode === m.id ? " is-active" : ""}`}
              onClick={() => updateTabEditorMode(tab.id, m.id)}
            >
              {m.icon}<span>{m.label}</span>
            </button>
          </Tooltip>
        ))}
      </div>
    </div>
  );
}
