import { useAppStore } from "../store";
import { useVaultStore } from "../store/vaultStore";
import { readFileEntry } from "./fileOps";
import { setEntrySection } from "./entryUi";
import { vaultErrorMessage } from "./vault";
import { toast } from "./toast";

/** How long to wait for the form to be on screen (the tab decrypts first) before giving up on scrolling to it. */
const SCROLL_TRIES = 20;

/** Opens a saved server's entry at its "Sign in" section, where "When both are saved" is changed. */
export async function openSshSignInSettings(path: string): Promise<void> {
  try {
    const file = await readFileEntry(path);
    useAppStore.getState().openVaultEntry(file, "permanent");
    const tabId = useAppStore.getState().activeTabId;
    if (tabId) setEntrySection(tabId, path.split("\\").join("/"), "signin");
    if (await useVaultStore.getState().ensureUnlocked()) await useAppStore.getState().unlockVaultTabs();
    let tries = 0;
    const scroll = () => {
      const el = document.getElementById("ssh-pref");
      if (el) el.scrollIntoView({ block: "center" });
      else if (++tries < SCROLL_TRIES) setTimeout(scroll, 100);
    };
    scroll();
  } catch (e) {
    toast.error(vaultErrorMessage(e));
  }
}
