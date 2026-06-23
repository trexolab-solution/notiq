import { useSyncExternalStore } from "react";
import { updater, type UpdaterState } from "../lib/updater";

/** Subscribe a component to the shared updater state (status, progress, etc.). */
export function useUpdater(): UpdaterState {
  return useSyncExternalStore(updater.subscribe, updater.getState, updater.getState);
}
