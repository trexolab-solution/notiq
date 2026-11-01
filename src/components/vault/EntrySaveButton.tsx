import { useState } from "react";
import { Save } from "lucide-react";
import { Button } from "../ui/Button";
import { Tooltip } from "../ui/Tooltip";
import { useAppStore } from "../../store";
import type { Tab } from "../../types";

/**
 * Save button for the structured vault entry editors. Enabled only while the tab
 * has unsaved changes; saving also renames the item to the entry's Name.
 */
export function EntrySaveButton({ tab }: { tab: Tab }) {
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try { await useAppStore.getState().saveTabToFile(tab.id); } finally { setSaving(false); }
  };
  return (
    <Tooltip content={tab.isDirty ? "Save changes" : "No unsaved changes"} shortcut="Ctrl+S">
      <Button size="sm" variant={tab.isDirty ? "primary" : "ghost"} icon={<Save size={13} />}
              disabled={!tab.isDirty || !tab.filePath} loading={saving} loadingText="Saving…"
              onClick={() => void save()}>
        Save
      </Button>
    </Tooltip>
  );
}
