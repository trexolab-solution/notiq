import { useCallback, type MutableRefObject } from "react";
import { rid, type Cv, type LinkObj } from "./graphData";

interface UseGraphLinkStylesParams {
  activeTabId: string | null;
  activeRef: MutableRefObject<string | null>;
  cvRef: MutableRefObject<Cv>;
  nodeColorMapRef: MutableRefObject<Map<string, string>>;
}

/**
 * Link (edge) visual callbacks for ForceGraph3D — colour, width, opacity and
 * particle styling, all brighter/thicker for links touching the active tab.
 */
export function useGraphLinkStyles({ activeTabId, activeRef, cvRef, nodeColorMapRef }: UseGraphLinkStylesParams) {
  // ── Link callbacks — clean, subtle, no arrows ──────────────────────────
  const isActiveLink = (l: LinkObj): boolean => {
    const a = activeRef.current;
    return !!(a && (rid(l.source) === a || rid(l.target) === a));
  };
  const sourceColor = (l: LinkObj): string =>
    nodeColorMapRef.current.get(rid(l.source)) ?? cvRef.current.primary;

  const linkColorFn = useCallback((l: LinkObj) => sourceColor(l), [activeTabId]);
  const linkWidthFn = useCallback((l: LinkObj) => isActiveLink(l) ? 2 : 0.8, [activeTabId]);
  const linkOpacityFn = useCallback((l: LinkObj) => isActiveLink(l) ? 0.7 : 0.3, [activeTabId]);
  const linkParticlesFn = useCallback((l: LinkObj) => isActiveLink(l) ? 4 : 1, [activeTabId]);
  const linkParticleSpeedFn = useCallback((l: LinkObj) => isActiveLink(l) ? 0.005 : 0.002, [activeTabId]);
  const linkParticleWidthFn = useCallback((l: LinkObj) => isActiveLink(l) ? 2.5 : 1, [activeTabId]);
  const linkParticleColorFn = useCallback((l: LinkObj) => sourceColor(l), [activeTabId]);

  return {
    linkColorFn, linkWidthFn, linkOpacityFn,
    linkParticlesFn, linkParticleSpeedFn, linkParticleWidthFn, linkParticleColorFn,
  };
}
