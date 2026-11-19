import type { StoreApi } from "zustand";
import type { Tab } from "../../types";
import type { AppState } from "./state";

/** What every slice of the app store gets: zustand's set/get plus the store-wide helpers. */
export interface SliceContext {
  set: StoreApi<AppState>["setState"];
  get: StoreApi<AppState>["getState"];
  /** Writes the session (tabs, active tab, theme) to IndexedDB. */
  persist: () => void;
  /** Update a single tab by id, merging `changes` into the matched tab. */
  updateTab: (id: string, changes: Partial<Tab>) => void;
  /** Shared save implementation — `forcePickPath` forces a Save-As dialog. */
  saveTabImpl: (id: string, forcePickPath: boolean) => Promise<boolean>;
}
