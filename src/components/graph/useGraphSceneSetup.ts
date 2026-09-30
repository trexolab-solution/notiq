import { useCallback, useEffect, useRef, type MutableRefObject } from "react";
import * as THREE from "three";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import type { AppView, ThemeId } from "../../types";
import type { Cv, FgNode } from "./graphData";

interface UseGraphSceneSetupParams {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ForceGraph3D ref has no public types
  graphRef: MutableRefObject<Record<string, any> | null>;
  cvRef: MutableRefObject<Cv>;
  size: { w: number; h: number };
  themeId: ThemeId;
  activeTabId: string | null;
  activeView: AppView;
  nodeCount: number;
}

/**
 * Manages the ForceGraph3D instance's lifecycle: initial scene setup (ACES
 * filmic-free rendering, hemisphere light, selective bloom, physics forces),
 * re-fitting/refreshing on data and theme changes, and resuming the idle
 * orbit + render loop whenever the graph view becomes visible.
 */
export function useGraphSceneSetup({
  graphRef, cvRef, size, themeId, activeTabId, activeView, nodeCount,
}: UseGraphSceneSetupParams) {
  const sceneReadyRef = useRef(false);
  const bloomPassRef = useRef<UnrealBloomPass | null>(null);

  // ── Zoom to fit on data change ──────────────────────────────────────────
  useEffect(() => {
    const id = setTimeout(() => graphRef.current?.zoomToFit(600, 50), 800);
    return () => clearTimeout(id);
  }, [nodeCount]);

  useEffect(() => { graphRef.current?.refresh(); }, [activeTabId, themeId]);

  // ── Scene setup — ACES filmic, hemisphere light, bloom pipeline ─────────
  const setupScene = useCallback(() => {
    const fg = graphRef.current; if (!fg) return;
    const scene = fg.scene?.() as THREE.Scene | undefined; if (!scene) return;
    const renderer = fg.renderer?.() as THREE.WebGLRenderer | undefined;
    const c = cvRef.current;
    const bgHex = c.bg;

    // Renderer
    if (renderer) {
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.toneMapping = THREE.NoToneMapping;
    }

    // Clean background
    scene.fog = null;
    scene.background = new THREE.Color(parseInt(bgHex.replace("#", ""), 16));
    const oldSky = scene.getObjectByName("__skybox");
    if (oldSky) { (oldSky as THREE.Mesh).geometry.dispose(); ((oldSky as THREE.Mesh).material as THREE.Material).dispose(); scene.remove(oldSky); }
    const oldEnv = scene.getObjectByName("__space_env");
    if (oldEnv) { oldEnv.traverse((o) => { (o as THREE.Mesh).geometry?.dispose(); ((o as THREE.Mesh).material as THREE.Material)?.dispose?.(); }); scene.remove(oldEnv); }

    // Lighting: ambient + directional + hemisphere
    for (const n of ["__al", "__dl", "__hl", "__k", "__f", "__r", "__n", "__rim"]) {
      const o = scene.getObjectByName(n); if (o) scene.remove(o);
    }
    const al = new THREE.AmbientLight(0xffffff, 0.6); al.name = "__al"; scene.add(al);
    const dl = new THREE.DirectionalLight(0xffffff, 0.5); dl.name = "__dl"; dl.position.set(100, 300, 200); scene.add(dl);
    const hl = new THREE.HemisphereLight(
      c.isLight ? 0xf0f0ff : 0x1a1a3e,
      c.isLight ? 0xfaf5e8 : 0x0a0a15,
      0.3,
    );
    hl.name = "__hl"; scene.add(hl);

    // Post-processing — selective bloom
    const composer = fg.postProcessingComposer?.();
    if (composer) {
      while (composer.passes.length > 1) composer.removePass(composer.passes[composer.passes.length - 1]);
      const bloom = new UnrealBloomPass(
        new THREE.Vector2(window.innerWidth, window.innerHeight),
        c.isLight ? 0.15 : 0.4,
        c.isLight ? 0.25 : 0.35,
        c.isLight ? 0.9 : 0.82,
      );
      composer.addPass(bloom);
      bloomPassRef.current = bloom;
    }

    // Camera controls — slow idle orbit
    const controls = fg.controls?.();
    if (controls) {
      controls.autoRotate = true;
      controls.autoRotateSpeed = 0.2;
      controls.enableDamping = true;
      controls.dampingFactor = 0.06;
      controls.minDistance = 40;
      controls.maxDistance = 1200;
    }

    // Physics
    fg.d3Force?.("charge")?.strength((n: FgNode) => (n.degree ?? 0) === 0 ? -25 : -180);
    fg.d3Force?.("link")?.distance(70);

    // Pull isolated nodes toward the cluster center
    fg.d3Force?.("isolatedCenter", (alpha: number) => {
      const nodes: FgNode[] = fg.graphData?.()?.nodes ?? [];
      if (nodes.length === 0) return;
      let cx = 0, cy = 0, cz = 0, count = 0;
      for (const n of nodes) {
        if ((n.degree ?? 0) > 0 && n.x != null) {
          cx += n.x; cy += n.y ?? 0; cz += n.z ?? 0; count++;
        }
      }
      if (count > 0) { cx /= count; cy /= count; cz /= count; }
      const strength = 0.12 * alpha;
      for (const n of nodes) {
        if ((n.degree ?? 0) === 0 && n.x != null) {
          n.vx = (n.vx ?? 0) + (cx - n.x) * strength;
          n.vy = (n.vy ?? 0) + (cy - (n.y ?? 0)) * strength;
          n.vz = (n.vz ?? 0) + (cz - (n.z ?? 0)) * strength;
        }
      }
    });

    fg.resumeAnimation?.();
    sceneReadyRef.current = true;
  }, []); // Stable: reads from refs (graphRef, cvRef, bloomPassRef, sceneReadyRef)

  // Trigger scene setup when size becomes valid
  useEffect(() => {
    if (size.w === 0) return;
    const t = setTimeout(setupScene, 200);
    return () => clearTimeout(t);
  }, [size.w, size.h, themeId, setupScene]);

  // Resume animation when graph view becomes visible
  useEffect(() => {
    if (activeView === "graph" && graphRef.current) {
      graphRef.current.resumeAnimation?.();
      const controls = graphRef.current.controls?.();
      if (controls) {
        controls.autoRotate = true;
        controls.autoRotateSpeed = 0.2;
      }
    }
  }, [activeView]);
}
