import { useEffect, useRef } from "react";
import { loadSession } from "../lib/session";
import { useAppStore, flushPendingPersist } from "../store";
import { scanOrphanTempFolders } from "../lib/attachments";
import { buildWelcomeNote, loadWelcomeImages } from "../config/welcomeNote";

let resolveSessionLoaded: () => void = () => {};
/** Settles once the saved session has been restored (or restoring failed) — anything that
 *  opens tabs at startup must wait for it, because `hydrate` replaces the tab list. */
export const sessionLoaded: Promise<void> = new Promise((r) => { resolveSessionLoaded = r; });

export function useSession() {
  const hydrate = useAppStore((s) => s.hydrate);
  const addTab = useAppStore((s) => s.addTab);
  const loaded = useRef(false);

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;

    loadSession().then(async (session) => {
      if (session && session.tabs.length > 0) {
        hydrate(session.tabs, session.activeTabId, session.themeId);
      } else {
        // First launch: the welcome note, with its bundled screenshots when they can be found.
        const images = await loadWelcomeImages();
        addTab({ title: "Welcome to Notiq", content: buildWelcomeNote(images), ...(images ? { attachments: images } : {}) });
      }
      // Reap orphaned per-tab temp attachment folders from prior sessions
      const activeIds = new Set(useAppStore.getState().tabs.map((t) => t.id));
      scanOrphanTempFolders(activeIds).catch((e) => console.warn("orphan scan failed", e));
    }).catch(() => {
      // Ensure the window still shows even if hydration fails
      useAppStore.setState({ sessionReady: true });
    }).finally(resolveSessionLoaded);
  }, []); // Init-once: hydrate/addTab are stable Zustand actions

  // Flush any pending timers on window close — Notepad++ behaviour
  useEffect(() => {
    const onBeforeUnload = () => {
      flushPendingPersist();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);
}
