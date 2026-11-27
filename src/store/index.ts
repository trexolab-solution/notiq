import { create } from "zustand";
import type { Tab } from "../types";
import type { AppState } from "./app/state";
import type { SliceContext } from "./app/context";
import { createPersist } from "./app/persist";
import { createSaveTab } from "./app/save";
import { createTabsSlice } from "./app/tabsSlice";
import { createViewSlice } from "./app/viewSlice";
import { createFileSlice } from "./app/fileSlice";
import { createVaultSlice } from "./app/vaultSlice";
import { createAppearanceSlice } from "./app/appearanceSlice";

export type { AppState } from "./app/state";
export { flushPendingPersist } from "./app/helpers";

// ─── store ──────────────────────────────────────────────────────────────────
// The store is split into slices under ./app; each gets set/get plus the shared helpers below.

export const useAppStore = create<AppState>((set, get) => {
  const persist = createPersist(get);

  /** Update a single tab by id, merging `changes` into the matched tab. */
  const updateTab = (id: string, changes: Partial<Tab>) => {
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...changes } : t)),
    }));
  };

  const saveTabImpl = createSaveTab({ get, persist, updateTab });
  const ctx: SliceContext = { set, get, persist, updateTab, saveTabImpl };

  return {
    ...createTabsSlice(ctx),
    ...createViewSlice(ctx),
    ...createFileSlice(ctx),
    ...createVaultSlice(ctx),
    ...createAppearanceSlice(ctx),
  };
});
