/**
 * react-kapsule wrapper for 3d-force-graph.
 *
 * We bypass the umbrella `react-force-graph` package because it imports
 * `3d-force-graph-vr` at module-load time, which calls AFRAME.registerComponent
 * unconditionally and crashes in any browser without an A-Frame runtime.
 */

// @ts-ignore — no standalone TS types for these kapsule packages
import fromKapsuleImport from "react-kapsule";
// @ts-ignore
import FG3DKapsuleImport from "3d-force-graph";

import type React from "react";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fromKapsule: (kapsule: any, opts?: any) => any = fromKapsuleImport;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const FG3DKapsule: any = FG3DKapsuleImport;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyProps = Record<string, any>;

export const ForceGraph3D: React.ComponentType<AnyProps> = fromKapsule(FG3DKapsule, {
  methodNames: [
    "emitParticle", "d3Force", "d3ReheatSimulation",
    "stopAnimation", "pauseAnimation", "resumeAnimation",
    "cameraPosition", "zoomToFit",
    "getGraphBbox", "screen2GraphCoords", "graph2ScreenCoords",
    "postProcessingComposer", "lights", "scene", "camera",
    "renderer", "controls", "refresh",
  ],
  initPropNames: ["controlType", "rendererConfig", "extraRenderers"],
});
