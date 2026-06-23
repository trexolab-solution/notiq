import React, { useEffect, useRef, useMemo, useState, useCallback } from "react";
import * as THREE from "three";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { ForceGraph3D } from "../../lib/forceGraph";
import { Maximize2 } from "lucide-react";
import { useAppStore } from "../../store";
import type { GraphNode, GraphLink } from "../../types";
import { Tooltip } from "../ui/Tooltip";

/* ── Theme colours ──────────────────────────────────────────────────────── */
type Cv = {
  primary: string; text: string; muted: string;
  bg: string; bgSec: string; border: string; isLight: boolean;
};
function luminance(hex: string): number {
  const c = hex.replace("#", "").padEnd(6, "0");
  return 0.2126 * (parseInt(c.slice(0, 2), 16) / 255) +
         0.7152 * (parseInt(c.slice(2, 4), 16) / 255) +
         0.0722 * (parseInt(c.slice(4, 6), 16) / 255);
}
function getCv(): Cv {
  const s = getComputedStyle(document.documentElement);
  const g = (v: string) => s.getPropertyValue(v).trim() || undefined;
  const bg = g("--color-bg") ?? "#0a0e1a";
  return {
    primary: g("--color-primary") ?? "#c9a84c",
    text: g("--color-text") ?? "#e2e8f0", muted: g("--color-text-muted") ?? "#94a3b8",
    bg, bgSec: g("--color-bg-secondary") ?? "#1e293b", border: g("--color-border") ?? "#334155",
    isLight: luminance(bg) > 0.45,
  };
}

/* ── Colour helpers ─────────────────────────────────────────────────────── */
function hslToHex(h: number, s: number, l: number): string {
  s /= 100; l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const to = (v: number) => Math.round(v * 255).toString(16).padStart(2, "0");
  return `#${to(f(0))}${to(f(8))}${to(f(4))}`;
}
function nodeColor(id: string, isLight: boolean): string {
  const sum = Array.from(id).reduce((a, c) => a + c.charCodeAt(0), 0);
  const hue = (sum * 137.508) % 360;
  return isLight ? hslToHex(hue, 50, 45) : hslToHex(hue, 45, 60);
}
function truncate(s: string, max = 22) { return s.length > max ? s.slice(0, max - 1) + "\u2026" : s; }
function degreeMap(nodes: GraphNode[], links: GraphLink[]): Record<string, number> {
  const d: Record<string, number> = {};
  nodes.forEach(n => (d[n.id] = 0));
  links.forEach(l => { d[l.source] = (d[l.source] || 0) + 1; d[l.target] = (d[l.target] || 0) + 1; });
  return d;
}
function nodeRadius(degree: number) { return 2 + Math.sqrt(Math.max(0, degree)) * 1.2; }

/* ── Fresnel rim shader ─────────────────────────────────────────────────── */
const FRESNEL_VS = /* glsl */ `
varying vec3 vNormal;
varying vec3 vViewDir;
void main() {
  vNormal = normalize(normalMatrix * normal);
  vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
  vViewDir = normalize(-mvPos.xyz);
  gl_Position = projectionMatrix * mvPos;
}
`;
const FRESNEL_FS = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
uniform float uFresnelPower;
void main() {
  float fresnel = pow(1.0 - abs(dot(normalize(vNormal), normalize(vViewDir))), uFresnelPower);
  gl_FragColor = vec4(uColor, fresnel * uOpacity);
}
`;
function makeFresnelMaterial(color: THREE.Color, isLight: boolean): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: color.clone() },
      uOpacity: { value: isLight ? 0.4 : 0.6 },
      uFresnelPower: { value: isLight ? 2.5 : 2.0 },
    },
    vertexShader: FRESNEL_VS,
    fragmentShader: FRESNEL_FS,
    transparent: true,
    blending: isLight ? THREE.NormalBlending : THREE.AdditiveBlending,
    side: THREE.FrontSide,
    depthWrite: false,
  });
}

/* ── Label sprite ───────────────────────────────────────────────────────── */
function makeLabel(text: string, isLight: boolean): THREE.Sprite {
  const label = truncate(text);
  const DPR = 2, W = 512 * DPR, H = 64 * DPR;
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(DPR, DPR);
  ctx.font = "600 16px 'Inter',ui-sans-serif,system-ui,-apple-system,sans-serif";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.shadowColor = isLight ? "rgba(255,255,255,0.8)" : "rgba(0,0,0,0.7)";
  ctx.shadowBlur = 4;
  ctx.fillStyle = isLight ? "rgba(15,23,42,0.95)" : "rgba(255,255,255,0.95)";
  ctx.fillText(label, 256, 32);
  ctx.shadowBlur = 0;
  ctx.fillText(label, 256, 32);
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter; tex.anisotropy = 4;
  const mat = new THREE.SpriteMaterial({
    map: tex, transparent: true, depthWrite: false,
    blending: THREE.NormalBlending,
  });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(48, 6, 1);
  return sprite;
}

/* ── Empty state ────────────────────────────────────────────────────────── */
function EmptyState({ cv }: { cv: Cv }) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-4 select-none"
      style={{ background: cv.bg }}>
      <div className="flex items-center justify-center w-16 h-16 rounded-2xl"
        style={{ background: `${cv.primary}18`, color: cv.primary, fontSize: 28 }}>{"\u25C8"}</div>
      <div className="text-center max-w-xs px-4">
        <p className="text-sm font-semibold mb-2" style={{ color: cv.text }}>No connections yet</p>
        <p className="text-xs leading-5" style={{ color: cv.muted }}>
          Link notes with markdown:{" "}
          <code className="px-1.5 py-0.5 rounded font-mono text-xs"
            style={{ background: cv.bgSec, color: cv.primary, border: `1px solid ${cv.border}` }}>
            [[Note Title]]
          </code>
        </p>
      </div>
    </div>
  );
}

/* ── Node material refs ─────────────────────────────────────────────────── */
type NodeMats = {
  core: THREE.MeshBasicMaterial;
  shell: THREE.ShaderMaterial;
  ring: THREE.Mesh | null;
  group: THREE.Group;
};

/* ── Force-graph node shape at runtime ──────────────────────────────────── */
interface FgNode {
  id: string;
  name: string;
  tabId?: string;
  degree: number;
  val: number;
  x?: number;
  y?: number;
  z?: number;
  vx?: number;
  vy?: number;
  vz?: number;
}

/* ── Graph inner ────────────────────────────────────────────────────────── */
function GraphInner() {
  const graphData = useAppStore((s) => s.graphData);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const navigateToNote = useAppStore((s) => s.navigateToNote);
  const themeId = useAppStore((s) => s.themeId);
  const activeView = useAppStore((s) => s.activeView);

  const cv = useMemo(getCv, [themeId]);
  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ForceGraph3D ref has no public types
  const graphRef = useRef<Record<string, any> | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const everMeasuredRef = useRef(false);
  const activeRef = useRef(activeTabId); activeRef.current = activeTabId;
  const cvRef = useRef(cv); cvRef.current = cv;
  const nodeMatRefs = useRef<Map<string, NodeMats>>(new Map());
  const hoveredNodeRef = useRef<string | null>(null);
  const nodeColorMapRef = useRef<Map<string, string>>(new Map());
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingClickRef = useRef<FgNode | null>(null);
  const sceneReadyRef = useRef(false);
  const bloomPassRef = useRef<UnrealBloomPass | null>(null);
  const animFrameRef = useRef<number>(0);
  const [tooltipData, setTooltipData] = useState<{ name: string; degree: number; id: string } | null>(null);
  const tooltipElemRef = useRef<HTMLDivElement>(null);
  const mouseRef = useRef({ x: 0, y: 0 });

  // ── Resize ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const el = containerRef.current; if (!el) return;
    const obs = new ResizeObserver((e) => {
      const { width: w, height: h } = e[0].contentRect;
      if (w > 0 && h > 0) everMeasuredRef.current = true;
      setSize({ w: Math.round(w), h: Math.round(h) });
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // ── Zoom to fit on data change ──────────────────────────────────────────
  useEffect(() => {
    const id = setTimeout(() => graphRef.current?.zoomToFit(600, 50), 800);
    return () => clearTimeout(id);
  }, [graphData.nodes.length]);

  useEffect(() => { graphRef.current?.refresh(); }, [activeTabId, themeId]);

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
  }, []);

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

  // ── Graph data ──────────────────────────────────────────────────────────
  const deg = useMemo(() => degreeMap(graphData.nodes, graphData.links), [graphData]);
  useEffect(() => {
    const m = new Map<string, string>();
    graphData.nodes.forEach(n => m.set(n.id, nodeColor(n.id, cv.isLight)));
    nodeColorMapRef.current = m;
  }, [graphData.nodes, deg, cv.isLight]);

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

  const fgNodes = useMemo(() => graphData.nodes.map(n => {
    const d = deg[n.id] ?? 0;
    return { id: n.id, name: n.name, tabId: n.tabId, degree: d, val: 1 + d * 0.4 };
  }), [graphData.nodes, deg]);
  const fgLinks = useMemo(() => graphData.links.map(l => ({ source: l.source, target: l.target })), [graphData.links]);
  const fgData = useMemo(() => ({ nodes: fgNodes, links: fgLinks }), [fgNodes, fgLinks]);

  // ── Animation loop — node breathing + active ring pulse (pauses when hidden) ─
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

  // ── Camera fly-to ──────────────────────────────────────────────────────
  const flyToNode = useCallback((node: FgNode) => {
    const fg = graphRef.current; if (!fg) return;
    const x = node.x ?? 0, y = node.y ?? 0, z = node.z ?? 0;
    const mag = Math.hypot(x, y, z);
    const dist = 85;
    if (mag < 0.5) fg.cameraPosition({ x, y, z: z + dist }, { x, y, z }, 800);
    else { const ratio = (mag + dist) / mag; fg.cameraPosition({ x: x * ratio, y: y * ratio, z: z * ratio }, { x, y, z }, 800); }
  }, []);

  const onNodeClick = useCallback((node: FgNode) => {
    if (clickTimerRef.current && pendingClickRef.current?.id === node.id) {
      clearTimeout(clickTimerRef.current); clickTimerRef.current = null; pendingClickRef.current = null;
      if (node.tabId) navigateToNote(node.tabId, node.name);
    } else {
      if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
      pendingClickRef.current = node;
      clickTimerRef.current = setTimeout(() => {
        clickTimerRef.current = null;
        const n = pendingClickRef.current; pendingClickRef.current = null;
        if (n) flyToNode(n);
      }, 350);
    }
  }, [navigateToNote, flyToNode]);

  // ── Hover — scale up + fresnel boost ───────────────────────────────────
  const onNodeHover = useCallback((node: FgNode | null) => {
    const nid = node?.id ?? null;
    const pid = hoveredNodeRef.current;
    hoveredNodeRef.current = nid;
    if (containerRef.current) containerRef.current.style.cursor = node ? "pointer" : "default";
    setTooltipData(node ? { name: node.name || String(node.id), degree: node.degree ?? 0, id: node.id } : null);

    // Reset previous hover
    if (pid && pid !== nid) {
      const m = nodeMatRefs.current.get(pid);
      if (m) {
        m.group.scale.set(1, 1, 1);
        m.shell.uniforms.uOpacity.value = cvRef.current.isLight ? 0.4 : 0.6;
      }
    }
    // Highlight new hover — scale + boost fresnel opacity
    if (nid) {
      const m = nodeMatRefs.current.get(nid);
      if (m) {
        m.group.scale.set(1.15, 1.15, 1.15);
        m.shell.uniforms.uOpacity.value = cvRef.current.isLight ? 0.7 : 0.9;
      }
    }
  }, []);

  // ── Link callbacks — clean, subtle, no arrows ──────────────────────────
  type LinkEndpoint = string | { id?: string };
  const rid = (ep: LinkEndpoint): string => typeof ep === "object" ? (ep?.id ?? "") : (ep ?? "");
  type LinkObj = { source: LinkEndpoint; target: LinkEndpoint };
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

  if (graphData.nodes.length === 0) return <EmptyState cv={cv} />;

  const stats = `${graphData.nodes.length} note${graphData.nodes.length !== 1 ? "s" : ""} \u00B7 ${graphData.links.length} link${graphData.links.length !== 1 ? "s" : ""}`;
  const show = size.w > 0 || everMeasuredRef.current;
  const overlayBg = cv.isLight ? "rgba(255,255,255,0.82)" : "rgba(15,20,30,0.80)";
  const overlayBorder = cv.isLight ? "rgba(0,0,0,0.08)" : "rgba(255,255,255,0.08)";

  return (
    <div ref={containerRef} style={{ flex: 1, minHeight: 0, position: "relative", overflow: "hidden", background: cv.bg }}
      onMouseMove={(e) => {
        const x = e.nativeEvent.offsetX, y = e.nativeEvent.offsetY;
        mouseRef.current = { x, y };
        if (tooltipElemRef.current) {
          tooltipElemRef.current.style.left = `${x + 14}px`;
          tooltipElemRef.current.style.top = `${y - 12}px`;
        }
      }}
    >
      {show && (
        <ForceGraph3D ref={graphRef} graphData={fgData} width={Math.max(1, size.w)} height={Math.max(1, size.h)}
          backgroundColor={"rgba(0,0,0,0)"}
          nodeRelSize={4} nodeThreeObject={nodeThreeObject} nodeLabel={() => ""}
          linkColor={linkColorFn} linkWidth={linkWidthFn} linkOpacity={linkOpacityFn}
          linkCurvature={0.1}
          linkDirectionalParticles={linkParticlesFn}
          linkDirectionalParticleWidth={linkParticleWidthFn}
          linkDirectionalParticleSpeed={linkParticleSpeedFn}
          linkDirectionalParticleColor={linkParticleColorFn}
          cooldownTicks={320} d3AlphaDecay={0.016} d3VelocityDecay={0.32}
          onNodeClick={onNodeClick} onNodeHover={onNodeHover}
          enableNodeDrag={true} enableNavigationControls={true} showNavInfo={false}
        />
      )}

      {/* Tooltip with colored dot */}
      {tooltipData && (
        <div ref={tooltipElemRef} role="tooltip" aria-label={tooltipData.name} style={{
          position: "absolute", left: mouseRef.current.x + 14, top: mouseRef.current.y - 12,
          zIndex: 20, pointerEvents: "none",
          padding: "6px 12px", borderRadius: 8,
          background: overlayBg, border: `1px solid ${overlayBorder}`,
          backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)",
          boxShadow: cv.isLight ? "0 2px 8px rgba(0,0,0,0.10)" : "0 2px 12px rgba(0,0,0,0.4)",
          fontSize: 12, color: cv.text, fontWeight: 500, whiteSpace: "nowrap",
        }}>
          <div style={{ fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{
              width: 8, height: 8, borderRadius: "50%", flexShrink: 0,
              background: nodeColorMapRef.current.get(tooltipData.id) ?? cv.primary,
            }} />
            {tooltipData.name}
          </div>
          <div style={{ color: cv.muted, fontSize: 11, fontWeight: 400, marginTop: 2 }}>
            {tooltipData.degree > 0 ? `${tooltipData.degree} connection${tooltipData.degree !== 1 ? "s" : ""}` : "No connections"}{" "}{"\u00B7"} Double-click to open
          </div>
        </div>
      )}

      {/* Stats badge */}
      <div style={{
        position: "absolute", top: 10, left: 10, zIndex: 10, fontSize: 11,
        padding: "5px 12px", borderRadius: 8,
        background: overlayBg, border: `1px solid ${overlayBorder}`,
        color: cv.muted, backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)",
        userSelect: "none", pointerEvents: "none",
      }}>
        {stats}
      </div>

      {/* Fit-view button */}
      <Tooltip content="Fit view">
        <button onClick={() => graphRef.current?.zoomToFit(500, 50)}
          style={{
            position: "absolute", top: 10, right: 10, zIndex: 10,
            display: "flex", alignItems: "center", justifyContent: "center",
            width: 30, height: 30, borderRadius: 7,
            border: `1px solid ${overlayBorder}`, background: overlayBg,
            color: cv.muted, cursor: "pointer",
            backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)",
            transition: "color .12s, border-color .12s",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = cv.text; e.currentTarget.style.borderColor = cv.primary; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = cv.muted; e.currentTarget.style.borderColor = overlayBorder; }}
        >
          <Maximize2 size={13} />
        </button>
      </Tooltip>

      {/* Help hint */}
      <div style={{
        position: "absolute", bottom: 10, left: "50%", transform: "translateX(-50%)",
        zIndex: 10, fontSize: 11, padding: "5px 14px", borderRadius: 20,
        background: overlayBg, border: `1px solid ${overlayBorder}`,
        color: cv.muted, backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)",
        pointerEvents: "none", userSelect: "none", whiteSpace: "nowrap",
      }}>
        Drag to rotate {"\u00B7"} Scroll to zoom {"\u00B7"} Click to focus {"\u00B7"} Double-click to open note
      </div>
    </div>
  );
}

export const KnowledgeGraph = React.memo(function KnowledgeGraph() {
  return (
    <div style={{ flex: 1, minHeight: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}>
      <GraphInner />
    </div>
  );
});
