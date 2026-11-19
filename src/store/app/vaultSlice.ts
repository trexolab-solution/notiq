import { isVaultPath, extFromPath, vaultLock, vaultReadFile, vaultWriteFile, vaultErrorMessage, vaultFileExists } from "../../lib/vault";
import { flushVaultPendingOps } from "../../lib/vaultPendingOps";
import { pickVaultDestination } from "../../lib/vaultDest";
import { scrubMonacoModels } from "../../lib/vaultMemory";
import { isSameOrUnder, remapPath } from "../../lib/vaultTree";
import { ensureVaultDir } from "../../lib/vaultDir";
import { toast } from "../../lib/toast";
import { useVaultStore } from "../vaultStore";
import { debounceGraphRebuild, titleFromPath } from "./helpers";
import type { SliceContext } from "./context";
import type { AppState } from "./state";

export type VaultSlice = Pick<
  AppState,
  "lockTabToVault" | "unlockVaultTabs" | "refreshVaultTabs" | "lockVault" | "remapVaultTabs" | "closeVaultTabs"
>;

/** Secure vault tabs: lock a note into the vault, decrypt / refresh / blank vault tabs, follow renames and trashing. */
export function createVaultSlice({ set, get, persist, updateTab, saveTabImpl }: SliceContext): VaultSlice {
  return {
    async lockTabToVault(id) {
      const tab = get().tabs.find((t) => t.id === id);
      if (!tab || tab.kind !== "note") return { ok: false };
      if (isVaultPath(tab.filePath)) return { ok: true };

      if (!(await useVaultStore.getState().ensureUnlocked())) return { ok: false };

      const plainPath = tab.filePath;
      // Offer a folder inside the vault storage folder (SSH, Logins, …).
      const target = await pickVaultDestination(tab.title);
      if (!target) return { ok: false };

      try {
        if (plainPath && (await vaultFileExists(target, await ensureVaultDir()))) {
          toast.error(`"${target.split(/[\\/]/).pop()}" already exists — rename or remove it first`);
          return { ok: false };
        }
        const ext = extFromPath(plainPath);
        await vaultWriteFile(target, tab.content, ext);
        updateTab(id, {
          filePath: target.replace(/\\/g, "/"),
          title: titleFromPath(target, tab.title),
          vaultExt: ext,
          vaultLocked: false,
          isDirty: false,
          updatedAt: Date.now(),
        });
      } catch (e) {
        toast.error(`Couldn't lock note: ${vaultErrorMessage(e)}`);
        return { ok: false };
      }
      get().rebuildGraph();
      persist();
      return { ok: true, plainPath };
    },

    async unlockVaultTabs() {
      const targets = get().tabs.filter((t) => isVaultPath(t.filePath) && t.vaultLocked);
      for (const t of targets) {
        try {
          const file = await vaultReadFile(t.filePath!);
          // The tab may have been closed while we were decrypting.
          if (!get().tabs.some((x) => x.id === t.id)) continue;
          updateTab(t.id, {
            content: file.content,
            vaultExt: file.ext || "md",
            vaultLocked: false,
            isDirty: false,
          });
        } catch (e) {
          // A tab restored from an earlier session whose entry is gone (deleted, or the vault was reset).
          if (/no longer exists/i.test(vaultErrorMessage(e))) { get().closeVaultTabs(t.filePath!); continue; }
          toast.error(`Couldn't open "${t.title}": ${vaultErrorMessage(e)}`);
        }
      }
      debounceGraphRebuild(() => get().rebuildGraph());
      persist();
    },

    async refreshVaultTabs() {
      const targets = get().tabs.filter((t) => isVaultPath(t.filePath) && !t.vaultLocked && !t.isDirty);
      for (const t of targets) {
        try {
          const file = await vaultReadFile(t.filePath!);
          const cur = get().tabs.find((x) => x.id === t.id);
          if (!cur || cur.isDirty || cur.vaultLocked || cur.content === file.content) continue;
          updateTab(t.id, { content: file.content, vaultExt: file.ext || "md", isDirty: false });
        } catch { /* file may not exist (yet) */ }
      }
    },

    async lockVault() {
      // Apply changes still waiting out their Undo window (e.g. attachment removals) while the vault is open.
      await flushVaultPendingOps();
      // Never lose edits: save dirty vault tabs first; abort the lock if any fails.
      const dirty = get().tabs.filter((t) => isVaultPath(t.filePath) && !t.vaultLocked && t.isDirty);
      for (const t of dirty) {
        if (!(await saveTabImpl(t.id, false))) {
          toast.error(`Couldn't save "${t.title}" — vault not locked`);
          return false;
        }
      }
      try {
        await vaultLock();
      } catch (e) {
        toast.error(`Couldn't lock vault: ${vaultErrorMessage(e)}`);
        return false;
      }
      useVaultStore.getState().setUnlocked(false);
      const vaultTabIds = get().tabs.filter((t) => isVaultPath(t.filePath)).map((t) => t.id);
      set((s) => ({
        tabs: s.tabs.map((t) =>
          isVaultPath(t.filePath) ? { ...t, content: "", isDirty: false, vaultLocked: true } : t,
        ),
      }));
      get().rebuildGraph();
      persist();
      // After React has swapped the editor for the lock screen, purge cached plaintext.
      setTimeout(() => void scrubMonacoModels(vaultTabIds), 100);
      return true;
    },

    remapVaultTabs(from, to) {
      let hit = false;
      set((s) => ({
        tabs: s.tabs.map((t) => {
          const next = t.filePath && isVaultPath(t.filePath) ? remapPath(t.filePath, from, to) : null;
          if (!next) return t;
          hit = true;
          return { ...t, filePath: next, title: titleFromPath(next, t.title) };
        }),
      }));
      if (!hit) return;
      debounceGraphRebuild(() => get().rebuildGraph());
      persist();
    },

    closeVaultTabs(path) {
      const ids = get().tabs
        .filter((t) => t.filePath && isVaultPath(t.filePath) && isSameOrUnder(t.filePath, path))
        .map((t) => t.id);
      if (ids.length === 0) return;
      const gone = new Set(ids);
      set((s) => {
        const tabs = s.tabs.filter((t) => !gone.has(t.id));
        let activeTabId = s.activeTabId;
        if (activeTabId && gone.has(activeTabId)) {
          const idx = s.tabs.findIndex((t) => t.id === activeTabId);
          activeTabId = tabs[Math.min(Math.max(0, idx - 1), tabs.length - 1)]?.id ?? null;
        }
        return { tabs, activeTabId };
      });
      setTimeout(() => void scrubMonacoModels(ids), 100);
      debounceGraphRebuild(() => get().rebuildGraph());
      persist();
    },
  };
}
