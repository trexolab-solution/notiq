// Stub for 3d-force-graph-vr and 3d-force-graph-ar.
// These are pulled in as static imports by react-force-graph but are never
// used — only ForceGraph3D is rendered. By replacing them with this no-op
// we prevent aframe-extras (and its THREE / AFRAME global references) from
// being evaluated at module-load time, which was crashing the app.
export default function noopKapsule(): () => void {
  return function () {};
}
