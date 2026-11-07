import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clamp } from '../util/math.ts';

/** 4-step cel-shading ramp shared by every toon material. */
export const toonRamp = (() => {
  const t = new THREE.DataTexture(new Uint8Array([105, 170, 228, 255]), 4, 1, THREE.RedFormat);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.needsUpdate = true;
  return t;
})();

/** Cel-shaded material with a cool rim light. */
export function toonMat(color: number, rim = 0x9fb0ff, rimAmt = 0.4): THREE.MeshToonMaterial {
  const m = new THREE.MeshToonMaterial({ color, gradientMap: toonRamp });
  const rc = new THREE.Color(rim);
  m.onBeforeCompile = (s) => {
    s.fragmentShader = s.fragmentShader.replace(/#include <(opaque|output)_fragment>/, (all) => `
{
  float rimF = 1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);
  outgoingLight += vec3(${rc.r.toFixed(3)}, ${rc.g.toFixed(3)}, ${rc.b.toFixed(3)}) * smoothstep(0.55, 0.75, rimF) * ${rimAmt.toFixed(2)};
}
${all}`);
  };
  m.customProgramCacheKey = () => `toon-rim-${rim}-${rimAmt}`;
  return m;
}

const outlineCache = new Map<number, THREE.MeshBasicMaterial>();
/** Black "inverted hull" outline material, shared per thickness. */
export function outlineMat(th: number): THREE.MeshBasicMaterial {
  const hit = outlineCache.get(th);
  if (hit) return hit;
  const m = new THREE.MeshBasicMaterial({ color: 0x07060c, side: THREE.BackSide });
  m.onBeforeCompile = (s) => {
    s.uniforms.uTh = { value: th };
    s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nuniform float uTh;')
      .replace('#include <begin_vertex>', 'vec3 transformed = position + normal * uTh;');
  };
  m.customProgramCacheKey = () => 'outline-hull';
  outlineCache.set(th, m);
  return m;
}

/** A cel-shaded mesh with a black outline around it. Children: [outline, body]. */
export function toonPart(geo: THREE.BufferGeometry, mat: THREE.Material, th = 0.011): THREE.Group {
  const g = new THREE.Group();
  const body = new THREE.Mesh(geo, mat);
  body.castShadow = body.receiveShadow = true;
  g.add(new THREE.Mesh(geo, outlineMat(th)), body);
  return g;
}

export const merge = (geos: THREE.BufferGeometry[]) => {
  const out = mergeGeometries(geos.map((g) => (g.index ? g.toNonIndexed() : g)));
  if (!out) throw new Error('mergeGeometries failed');
  return out;
};

/** Average normals of vertices that share a position (closes UV seams). */
export function weldNormals(geo: THREE.BufferGeometry): void {
  const p = geo.attributes.position as THREE.BufferAttribute, n = geo.attributes.normal as THREE.BufferAttribute;
  const map = new Map<string, { n: THREE.Vector3; ids: number[] }>();
  for (let i = 0; i < p.count; i++) {
    const k = `${Math.round(p.getX(i) * 1e4)},${Math.round(p.getY(i) * 1e4)},${Math.round(p.getZ(i) * 1e4)}`;
    let e = map.get(k);
    if (!e) map.set(k, (e = { n: new THREE.Vector3(), ids: [] }));
    e.n.x += n.getX(i); e.n.y += n.getY(i); e.n.z += n.getZ(i); e.ids.push(i);
  }
  for (const e of map.values()) { e.n.normalize(); for (const i of e.ids) n.setXYZ(i, e.n.x, e.n.y, e.n.z); }
}

const h3 = (x: number, y: number, z: number, k: number) => { const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7 + k * 19.19) * 43758.5453; return s - Math.floor(s); };
function worley(x: number, y: number, z: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  let best = 9;
  for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
    const cx = xi + a, cy = yi + b, cz = zi + c;
    const dx = x - (cx + h3(cx, cy, cz, 1)), dy = y - (cy + h3(cx, cy, cz, 2)), dz = z - (cz + h3(cx, cy, cz, 3));
    best = Math.min(best, dx * dx + dy * dy + dz * dz);
  }
  return Math.sqrt(best);
}

export interface TuftOptions { cell?: number; amp?: number; droop?: number }
/**
 * Shapes a geometry: fn(v) moves each vertex and returns how "tufty" that spot is (0 = smooth).
 * Cone-shaped fur tufts are then pushed out along the normal, giving the jagged cartoon outline.
 * The smooth pre-tuft normals are kept, so the inside shades flat and only the silhouette is spiky.
 */
export function toonShape(geo: THREE.BufferGeometry, fn: (v: THREE.Vector3) => number | void, { cell = 0.05, amp = 0.024, droop = 0.45 }: TuftOptions = {}): THREE.BufferGeometry {
  const p = geo.attributes.position as THREE.BufferAttribute, v = new THREE.Vector3(), amps = new Float32Array(p.count);
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const a = fn(v);
    amps[i] = typeof a === 'number' ? a : 1;
    p.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  weldNormals(geo);
  if (amp > 0) {
    const n = geo.attributes.normal as THREE.BufferAttribute, d = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      if (amps[i] <= 0) continue;
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const f = worley(x / cell, y / cell, z / cell);
      const s = Math.pow(clamp(1 - f * 1.5, 0, 1), 1.25) * amp * amps[i];
      d.set(n.getX(i), n.getY(i) - droop * 0.6, n.getZ(i)).normalize();
      p.setXYZ(i, x + d.x * s, y + d.y * s, z + d.z * s);
    }
  }
  geo.computeBoundingSphere();
  return geo;
}

/** Capsule with evenly spaced rows all the way up (three's capsule has one long row in the middle). */
export function capsule(r: number, len: number, radial: number, rows: number): THREE.LatheGeometry {
  const total = Math.PI * r + len, q = (Math.PI * r) / 2, pts: THREE.Vector2[] = [];
  for (let i = 0; i <= rows; i++) {
    const s = (i / rows) * total;
    let x: number, y: number;
    if (s < q) { const a = s / r; x = r * Math.sin(a); y = -len / 2 - r * Math.cos(a); }
    else if (s < q + len) { x = r; y = -len / 2 + (s - q); }
    else { const a = (s - q - len) / r + Math.PI / 2; x = r * Math.sin(a); y = len / 2 - r * Math.cos(a); }
    pts.push(new THREE.Vector2(Math.max(x, 0), y));
  }
  return new THREE.LatheGeometry(pts, radial);
}
