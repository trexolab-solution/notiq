import { useEffect, useState } from "react";
import { vaultPanelWidth } from "../lib/vaultPanelWidth";
import { usePanelResize } from "./usePanelResize";

/** Vault sidebar width + right-edge drag resize; the maximum follows the window width. */
export function useVaultPanelResize() {
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return usePanelResize(vaultPanelWidth, { edge: "right", available: windowWidth, label: "Resize vault sidebar" });
}
