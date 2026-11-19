import { useEffect, useMemo } from "react";
import type { VaultItem } from "../../../../lib/vault";
import { followSyncMarkers, markerIndex, reviewList, useSyncMarkersStore } from "../../../../lib/syncMarkers";

/** "Changed by sync" markers: dots in the tree, the Recently synced view. */
export function useSyncReview(items: VaultItem[]) {
  const syncMarkers = useSyncMarkersStore((s) => s.markers);
  const reviewOpen = useSyncMarkersStore((s) => s.reviewOpen);
  const setReviewOpen = useSyncMarkersStore((s) => s.setReviewOpen);
  useEffect(() => followSyncMarkers(), []);
  // A rename or move here changes where a marked entry is.
  useEffect(() => { void useSyncMarkersStore.getState().refresh(); }, [items]);
  const marks = useMemo(() => markerIndex(syncMarkers), [syncMarkers]);
  const syncedCount = useMemo(() => reviewList(syncMarkers).length, [syncMarkers]);
  const markAllSeen = () => void useSyncMarkersStore.getState().clearAll();
  return { syncMarkers, reviewOpen, setReviewOpen, marks, syncedCount, markAllSeen };
}
