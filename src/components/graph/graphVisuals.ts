import * as THREE from "three";
import { truncate } from "./graphData";

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
export function makeFresnelMaterial(color: THREE.Color, isLight: boolean): THREE.ShaderMaterial {
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
export function makeLabel(text: string, isLight: boolean): THREE.Sprite {
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

/* ── Node material refs ─────────────────────────────────────────────────── */
export type NodeMats = {
  core: THREE.MeshBasicMaterial;
  shell: THREE.ShaderMaterial;
  ring: THREE.Mesh | null;
  group: THREE.Group;
};
