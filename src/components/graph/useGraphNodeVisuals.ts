import { useCallback, useEffect, useRef, type MutableRefObject } from "react";
import * as THREE from "three";
import type { AppView, GraphData } from "../../types";
import { nodeRadius, type Cv, type FgNode } from "./graphData";
import { makeFresnelMaterial, makeLabel, type NodeMats } from "./graphVisuals";

interface UseGraphNodeVisualsParams {
  graphData: GraphData;
  activeTabId: string | null;
  activeRef: MutableRefObject<string | null>;
  activeView: AppView;
  cvRef: MutableRefObject<Cv>;
  nodeColorMapRef: MutableRefObject<Map<string, string>>;
}

/**
 * Owns the Three.js side of each node: the dual-layer (core + fresnel shell)
 * mesh group built by `nodeThreeObject`, the active-tab ring that follows
 * `activeTabId`, the idle breathing/pulse animation loop, and GPU cleanup
 * when the underlying graph data changes.
 */
export function useGraphNodeVisuals({
  graphData, activeTabId, activeRef, activeView, cvRef, nodeColorMapRef,
}: UseGraphNodeVisualsParams) {
  const nodeMatRefs = useRef<Map<string, NodeMats>>(new Map());
  const hoveredNodeRef = useRef<string | null>(null);

  // Dispose old Three.js objects when graph data changes to prevent GPU memory leaks
  useEffect(() => {
    return () => {
      nodeMatRefs.current.forEach((mats) => {
        mats.group.traverse((child) => {
          if (child instanceof THREE.Mesh) {
            child.geometry.dispose();
            if (child.material instanceof THREE.Material) child.material.dispose();
          }
          if (child instanceof THREE.Sprite) {
            child.material.map?.dispose();
            child.material.dispose();
          }
        });
      });
      nodeMatRefs.current.clear();
    };
  }, [graphData]);

  // ── Imperatively update active-node visuals on tab switch ───────────────
  const prevActiveRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevActiveRef.current;
    const curr = activeTabId;
    prevActiveRef.current = curr;

    // Remove ring from previously active node
    if (prev && prev !== curr) {
      const m = nodeMatRefs.current.get(prev);
      if (m && m.ring) {
        m.group.remove(m.ring);
        m.ring.geometry.dispose();
        (m.ring.material as THREE.Material).dispose();
        m.ring = null;
      }
    }

    // Add ring to newly active node
    if (curr && curr !== prev) {
      const m = nodeMatRefs.current.get(curr);
      if (m && !m.ring) {
        const shellMesh = m.group.children.find(
          c => c instanceof THREE.Mesh && (c as THREE.Mesh).material === m.shell
        ) as THREE.Mesh | undefined;
        const r = shellMesh
          ? (shellMesh.geometry as THREE.SphereGeometry).parameters.radius
          : nodeRadius(0);
        const torusGeo = new THREE.TorusGeometry(r * 1.5, 0.25, 8, 48);
        const torusMat = new THREE.MeshBasicMaterial({
          color: m.core.color, transparent: true, opacity: 0.5,
        });
        const ring = new THREE.Mesh(torusGeo, torusMat);
        ring.rotation.x = Math.PI / 2;
        m.group.add(ring);
        m.ring = ring;
      }
    }
  }, [activeTabId]);

  // ── Animation loop — node breathing + active ring pulse (pauses when hidden) ─
  const animFrameRef = useRef<number>(0);
  useEffect(() => {
    if (activeView !== "graph") return;
    const t0 = performance.now();
    const tick = () => {
      const t = (performance.now() - t0) / 1000;
      nodeMatRefs.current.forEach((mats, id) => {
        // Breathing: ±1.5% scale, unique phase per node
        const hash = Array.from(id).reduce((a, c) => a + c.charCodeAt(0), 0);
        const phase = (hash * 0.1) % (Math.PI * 2);
        const breath = 1 + Math.sin(t * 1.2 + phase) * 0.015;
        if (hoveredNodeRef.current !== id) {
          mats.group.scale.set(breath, breath, breath);
        }
        // Active ring pulse: scale ±10%, opacity 0.5 ± 0.15
        if (mats.ring) {
          const pulse = Math.sin(t * 2.1) * 0.5 + 0.5;
          const s = 1 + pulse * 0.1;
          mats.ring.scale.set(s, s, s);
          (mats.ring.material as THREE.MeshBasicMaterial).opacity = 0.5 + pulse * 0.15;
        }
      });
      animFrameRef.current = requestAnimationFrame(tick);
    };
    animFrameRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animFrameRef.current);
  }, [activeView]);

  // ── Custom 3-D node — dual layer: bright core + fresnel shell ───────────
  const nodeThreeObject = useCallback((node: FgNode): THREE.Group => {
    const d = node.degree ?? 0;
    const r = nodeRadius(d);
    const c = cvRef.current;
    const isAct = node.tabId === activeRef.current;
    const color = nodeColorMapRef.current.get(node.id) ?? c.primary;
    const col3 = new THREE.Color(color);

    const group = new THREE.Group();

    // Inner core — MeshBasicMaterial (fully bright → exceeds bloom threshold → glows)
    const coreGeo = new THREE.SphereGeometry(r * 0.35, 16, 12);
    const coreMat = new THREE.MeshBasicMaterial({ color: col3 });
    group.add(new THREE.Mesh(coreGeo, coreMat));

    // Outer shell — fresnel rim shader (transparent face-on, glows at edges)
    const shellGeo = new THREE.SphereGeometry(r, 32, 24);
    const shellMat = makeFresnelMaterial(col3, c.isLight);
    group.add(new THREE.Mesh(shellGeo, shellMat));

    // Active ring — MeshBasicMaterial (blooms with the core)
    let ring: THREE.Mesh | null = null;
    if (isAct) {
      const torusGeo = new THREE.TorusGeometry(r * 1.5, 0.25, 8, 48);
      const torusMat = new THREE.MeshBasicMaterial({
        color: col3, transparent: true, opacity: 0.5,
      });
      ring = new THREE.Mesh(torusGeo, torusMat);
      ring.rotation.x = Math.PI / 2;
      group.add(ring);
    }

    // Label
    const label = makeLabel(node.name || String(node.id), c.isLight);
    label.position.set(0, -(r + 6), 0);
    group.add(label);

    nodeMatRefs.current.set(node.id, { core: coreMat, shell: shellMat, ring, group });
    return group;
  }, []); // Stable: reads from refs (cvRef, activeRef, nodeColorMapRef)

  return { nodeThreeObject, nodeMatRefs, hoveredNodeRef };
}
