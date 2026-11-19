import type { Tab } from "../../types";
import { pickSavePath, writeFile } from "../../lib/fileOps";
import { isVaultPath, vaultRename, vaultWriteFile, vaultErrorMessage } from "../../lib/vault";
import { sweepUnusedVaultImages } from "../../lib/vaultImageSweep";
import { entryTitleOf, isStructuredExt, withEntryTitle } from "../../lib/entryName";
import { planEntryRename } from "../../lib/entrySync";
import { migrateTempToSaveDir } from "../../lib/attachments";
import { toast } from "../../lib/toast";
import { useVaultStore } from "../vaultStore";
import { titleFromPath } from "./helpers";
import type { SliceContext } from "./context";

/** Builds the shared save implementation (`forcePickPath` forces a Save-As dialog). */
export function createSaveTab({ get, persist, updateTab }: Omit<SliceContext, "set" | "saveTabImpl">) {
  /**
   * Saves a structured vault entry (login, secret kinds, recovery codes). Its Name
   * is the item name: the entry is renamed to match (same entry id, so Vault Sync
   * sees a rename, not a delete + create), and the stored title is set to the name
   * it ended up with (sanitized, " 2" on a clash, the old name when left empty).
   */
  const saveStructuredEntry = async (
    tab: Tab, path: string, ext: string, attachments: Tab["attachments"],
  ): Promise<boolean> => {
    let plan = { name: "", to: path };
    try {
      plan = (await planEntryRename(path, entryTitleOf(tab.content) ?? "")) ?? plan;
    } catch (e) {
      console.warn("save: couldn't work out the entry name", e);
    }
    const content = plan.name ? withEntryTitle(tab.content, plan.name) : tab.content;
    try {
      await vaultWriteFile(path, content, ext);
    } catch (e) {
      toast.error(`Couldn't save "${tab.title}": ${vaultErrorMessage(e)}`);
      return false;
    }
    if (plan.to !== path) {
      try {
        await vaultRename(path, plan.to);
        get().remapVaultTabs(path, plan.to);
      } catch (e) {
        toast.error(`Saved, but couldn't rename it to "${plan.name}": ${vaultErrorMessage(e)}`);
      }
    }
    // Keystrokes typed while saving stay (and keep the tab dirty).
    const cur = get().tabs.find((t) => t.id === tab.id);
    if (!cur) return true;
    const untouched = cur.content === tab.content;
    updateTab(tab.id, {
      vaultExt: ext,
      attachments,
      ...(untouched ? { content, isDirty: false } : {}),
      updatedAt: Date.now(),
    });
    get().rebuildGraph();
    persist();
    return true;
  };

  /** Shared save implementation — `forcePickPath` forces a Save-As dialog. */
  const saveTabImpl = async (id: string, forcePickPath: boolean): Promise<boolean> => {
    const tab = get().tabs.find((t) => t.id === id);
    if (!tab) return false;
    // A locked vault tab has empty content — saving it would wipe the note.
    if (tab.vaultLocked) return false;
    // The Settings and remote-files tabs have nothing to save.
    if (tab.kind === "settings" || tab.kind === "files") return false;
    const path = forcePickPath
      ? await pickSavePath(tab.title)
      : (tab.filePath ?? await pickSavePath(tab.title));
    if (!path) return false;

    // Migrate any temp attachments to <note-dir>/<rel> BEFORE writing the markdown.
    // If migration fails, abort: the .md must not reference files that aren't there.
    let migratedAttachments = tab.attachments;
    if (tab.attachments && Object.keys(tab.attachments).length > 0) {
      try {
        migratedAttachments = await migrateTempToSaveDir(tab, path);
      } catch (e) {
        console.error("save: attachment migration failed", e);
        toast.error("Couldn't save attachments — note not saved");
        return false;
      }
    }

    let vaultExt = tab.vaultExt;
    if (isVaultPath(path)) {
      if (!(await useVaultStore.getState().ensureUnlocked())) return false;
      vaultExt = vaultExt ?? "md";
      if (isStructuredExt(vaultExt)) return saveStructuredEntry(tab, path, vaultExt, migratedAttachments);
      try {
        await vaultWriteFile(path, tab.content, vaultExt);
      } catch (e) {
        toast.error(`Couldn't save locked note: ${vaultErrorMessage(e)}`);
        return false;
      }
      // Not awaited: the save never waits on (or fails because of) the image cleanup.
      void sweepUnusedVaultImages(path, tab.content);
    } else {
      await writeFile(path, tab.content);
      vaultExt = undefined;
    }
    updateTab(id, {
      filePath: path,
      vaultExt,
      title: titleFromPath(path, tab.title),
      isDirty: false,
      updatedAt: Date.now(),
      attachments: migratedAttachments,
    });
    get().rebuildGraph();
    persist();
    return true;
  };

  return saveTabImpl;
}
