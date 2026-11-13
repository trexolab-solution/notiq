import { useState } from "react";
import { SettingRow } from "../SettingRow";
import { SettingsGroup } from "../SettingsGroup";
import { Toggle } from "../Toggle";
import { SegmentedControl } from "../SegmentedControl";
import { NumberStepper } from "../NumberStepper";
import {
  DEFAULT_FILES_PREFS as D, EDITOR_FONT_MAX, EDITOR_FONT_MIN, getFilesPrefs, setFilesPrefs, type FilesPrefs,
} from "../../../lib/filesPrefs";
import type { SettingMeta } from "../../../lib/settingsIndex";

const KW = ["sftp", "remote files", "ssh", "file manager", "server"];

/** The remote file manager's preferences (Settings → Vault). They apply to file managers opened afterwards. */
export function FileManagerSettings() {
  const [p, setP] = useState<FilesPrefs>(() => getFilesPrefs());
  const change = (patch: Partial<FilesPrefs>) => setP(setFilesPrefs(patch));

  return (
    <SettingsGroup title="File manager" description="How the remote file manager lists, opens and edits files. Applies to file managers you open next.">
      <SettingRow id="vault.files.hidden" label="Show hidden files" description="List files and folders whose name starts with a dot (.bashrc, .ssh)."
                  keywords={[...KW, "dot files", "hidden"]} modified={p.showHidden !== D.showHidden} onReset={() => change({ showHidden: D.showHidden })}>
        <Toggle aria-label="Show hidden files" value={p.showHidden} onChange={(v) => change({ showHidden: v })} />
      </SettingRow>

      <SettingRow id="vault.files.view" label="Layout" description="A list with size, date and permissions, or a grid of icons. The buttons in the file manager change it too."
                  keywords={[...KW, "list", "grid", "icons", "view", "layout"]} modified={p.view !== D.view} onReset={() => change({ view: D.view })}>
        <SegmentedControl aria-label="File manager layout" value={p.view} onChange={(v) => change({ view: v as FilesPrefs["view"] })}
                          options={[{ value: "list", label: "List" }, { value: "grid", label: "Grid" }]} />
      </SettingRow>

      <SettingRow id="vault.files.grid-size" label="Grid item size" keywords={[...KW, "grid", "icons", "size", "small", "large", "thumbnail"]}
                  modified={p.gridSize !== D.gridSize} onReset={() => change({ gridSize: D.gridSize })}>
        <SegmentedControl aria-label="Grid item size" value={p.gridSize} onChange={(v) => change({ gridSize: v as FilesPrefs["gridSize"] })}
                          options={[{ value: "small", label: "Small" }, { value: "medium", label: "Medium" }, { value: "large", label: "Large" }]} />
      </SettingRow>

      <SettingRow id="vault.files.sort" label="Sort files by" description="Folders always come first."
                  keywords={[...KW, "order", "name", "size", "date", "modified"]} modified={p.sortKey !== D.sortKey} onReset={() => change({ sortKey: D.sortKey })}>
        <SegmentedControl aria-label="Sort files by" value={p.sortKey} onChange={(v) => change({ sortKey: v as FilesPrefs["sortKey"] })}
                          options={[{ value: "name", label: "Name" }, { value: "size", label: "Size" }, { value: "mtime", label: "Modified" }]} />
      </SettingRow>

      <SettingRow id="vault.files.sort-order" label="Sort order" keywords={[...KW, "ascending", "descending", "newest", "largest"]}
                  modified={p.sortDesc !== D.sortDesc} onReset={() => change({ sortDesc: D.sortDesc })}>
        <SegmentedControl aria-label="Sort order" value={p.sortDesc ? "desc" : "asc"} onChange={(v) => change({ sortDesc: v === "desc" })}
                          options={[{ value: "asc", label: "A to Z / smallest" }, { value: "desc", label: "Z to A / largest" }]} />
      </SettingRow>

      <SettingRow id="vault.files.open-action" label="Double-click on a file" description="Open it here (pictures are shown, text is edited), or download it."
                  keywords={[...KW, "open", "download", "double click", "enter"]} modified={p.openAction !== D.openAction} onReset={() => change({ openAction: D.openAction })}>
        <SegmentedControl aria-label="Double-click on a file" value={p.openAction} onChange={(v) => change({ openAction: v as FilesPrefs["openAction"] })}
                          options={[{ value: "open", label: "Open" }, { value: "download", label: "Download" }]} />
      </SettingRow>

      <SettingRow id="vault.files.use-trash" label="Move deleted items to the Trash" description="Deleted files and folders go to the server's Trash (~/.local/share/Trash) so you can restore them. Turn off to delete them permanently at once."
                  keywords={[...KW, "trash", "recycle bin", "delete", "restore", "undo"]} modified={p.useTrash !== D.useTrash} onReset={() => change({ useTrash: D.useTrash })}>
        <Toggle aria-label="Move deleted items to the Trash" value={p.useTrash} onChange={(v) => change({ useTrash: v })} />
      </SettingRow>

      <SettingRow id="vault.files.confirm-delete" label="Ask before deleting permanently" description="Permanent deletion can't be undone. Turn this off only if you want it to happen at once."
                  keywords={[...KW, "delete", "confirm", "remove"]} modified={p.confirmDelete !== D.confirmDelete} onReset={() => change({ confirmDelete: D.confirmDelete })}>
        <Toggle aria-label="Ask before deleting permanently" value={p.confirmDelete} onChange={(v) => change({ confirmDelete: v })} />
      </SettingRow>

      <SettingRow id="vault.files.editor-wrap" label="Wrap long lines in the editor" keywords={[...KW, "editor", "word wrap", "text"]}
                  modified={p.editorWrap !== D.editorWrap} onReset={() => change({ editorWrap: D.editorWrap })}>
        <Toggle aria-label="Wrap long lines in the editor" value={p.editorWrap} onChange={(v) => change({ editorWrap: v })} />
      </SettingRow>

      <SettingRow id="vault.files.editor-font" label="Editor font size" keywords={[...KW, "editor", "text size", "zoom"]}
                  modified={p.editorFontSize !== D.editorFontSize} onReset={() => change({ editorFontSize: D.editorFontSize })}>
        <NumberStepper value={p.editorFontSize} onChange={(v) => change({ editorFontSize: v })} min={EDITOR_FONT_MIN} max={EDITOR_FONT_MAX} step={1}
                       formatValue={(v) => `${v} px`} aria-label="File manager editor font size" />
      </SettingRow>
    </SettingsGroup>
  );
}

const meta = (id: string, label: string, description: string, extra: string[] = []): SettingMeta =>
  ({ id, section: "vault", group: "File manager", label, description, keywords: [...KW, ...extra] });

/** The searchable settings this group renders (see lib/settingsIndex.ts). */
export const FILES_INDEX: SettingMeta[] = [
  meta("vault.files.hidden", "Show hidden files", "List files and folders whose name starts with a dot (.bashrc, .ssh).", ["dot files", "hidden"]),
  meta("vault.files.view", "Layout", "A list with size, date and permissions, or a grid of icons.", ["list", "grid", "icons", "view", "layout"]),
  meta("vault.files.grid-size", "Grid item size", "", ["grid", "icons", "size", "small", "large", "thumbnail"]),
  meta("vault.files.sort", "Sort files by", "Folders always come first.", ["order", "name", "size", "date", "modified"]),
  meta("vault.files.sort-order", "Sort order", "Ascending or descending.", ["ascending", "descending", "newest", "largest"]),
  meta("vault.files.open-action", "Double-click on a file", "Open it here (pictures are shown, text is edited), or download it.", ["open", "download", "double click", "enter"]),
  meta("vault.files.use-trash", "Move deleted items to the Trash", "Deleted files and folders go to the server's Trash so you can restore them.", ["trash", "recycle bin", "delete", "restore", "undo"]),
  meta("vault.files.confirm-delete", "Ask before deleting permanently", "Permanent deletion can't be undone.", ["delete", "confirm", "remove"]),
  meta("vault.files.editor-wrap", "Wrap long lines in the editor", "", ["editor", "word wrap", "text"]),
  meta("vault.files.editor-font", "Editor font size", "", ["editor", "text size", "zoom"]),
];
