import * as THREE from 'three';
import { clamp, lerp, smooth } from '../util/math.ts';
import { capsule, merge, toonMat, toonPart, toonRamp, toonShape } from './toon.ts';

/*
 * The owl mascot model. Everything here is built ONCE into a template; each player's owl is a cheap
 * clone of it that shares geometry and materials (see owl.ts).
 *
 * The head is the mascot drawing: a round fuzzy ball with a giant screaming open beak (a real hole
 * cut into the face), mismatched googly eyes and two small ear tufts. It sits on a tiny slim body.
 */

const BODY = { a: 0.62, b: 0.52, c: 0.5 };            // head ball half-extents (head units)
export const EYES = [
  { x: -0.275, y: 0.13, r: 0.2, pupil: [-0.05, -0.005] as const, pr: 0.036 },   // big one (viewer's left)
  { x: 0.25, y: 0.205, r: 0.135, pupil: [0.045, 0.018] as const, pr: 0.027 },   // small one, higher up
];
export const RING = 0.034;
const MOUTH_TOP = { x: 0.02, y: 0.215 };
type P2 = readonly [number, number];
const MOUTH: P2[] = [[0, 0], [-0.147, -0.392], [0, -0.317], [0.12, -0.377], [0.06, -0.125]];
const MANDIBLE: P2[] = [[0, 0.004], [-0.094, -0.188], [-0.03, -0.163], [0.022, -0.142], [0.062, -0.126]];
const THROAT: P2[] = [[-0.09, -0.185], [-0.118, -0.262], [-0.03, -0.22], [0.05, -0.205], [0.07, -0.16], [0.062, -0.126]];

/** Rig layout (rig units; the rig is scaled to 70%, so the owl stands ~0.9 m tall). */
export const RIG = { scale: 0.7, hip: 0.405, headScale: 0.34, headY: 0.155 };

function mouthDist(x: number, y: number): number {
  const t = clamp((MOUTH_TOP.y - y) / 0.39, 0, 1), halfW = 0.135 * t;
  return Math.max(Math.abs(x - MOUTH_TOP.x + 0.01) - halfW, y - MOUTH_TOP.y, MOUTH_TOP.y - 0.4 - y);
}

function headGeometry(seg: number, tufts: boolean): THREE.BufferGeometry {
  return toonShape(new THREE.SphereGeometry(1, seg, Math.round(seg * 0.75)), (v) => {
    const d = v.clone();
    const n = 2.25, k = Math.pow(Math.abs(d.x) ** n + Math.abs(d.y) ** n + Math.abs(d.z) ** n, 1 / n);
    v.set(lerp(d.x, d.x / k, 0.5), lerp(d.y, d.y / k, 0.5), lerp(d.z, d.z / k, 0.5));
    v.x *= 1 + 0.07 * clamp(-d.y, 0, 1);
    if (d.y < -0.55) v.y = -0.55 + (v.y + 0.55) * 0.75;
    if (d.z > 0) v.z *= 0.93;
    let tuft = 1;
    for (const [sx, big, px, py] of [[-1, 0.9, -0.62, 0.7], [1, 1.1, 0.58, 0.74]] as const) {   // two small ear tufts
      const dist = Math.hypot(d.x - px, d.y - py, d.z * 0.9);
      const c = Math.pow(clamp(1 - dist / 0.32, 0, 1), 2.0) * big;
      v.y += 0.38 * c; v.x += sx * 0.1 * c;
      tuft += 1.4 * c;
    }
    v.x *= BODY.a; v.y *= BODY.b; v.z *= BODY.c;
    let a = tuft * (1 - smooth(0.35, 0.75, d.z));            // jagged fur round the edges, clean face
    if (d.z > 0) {
      for (const e of EYES) a *= smooth(e.r, e.r + 0.06, Math.hypot(v.x - e.x, v.y - e.y));
      a *= smooth(0.0, 0.07, mouthDist(v.x, v.y));
    }
    return a;
  }, tufts ? { cell: 0.075, amp: 0.065, droop: 0.55 } : { amp: 0 });
}
function torsoGeometry() {
  return toonShape(capsule(0.165, 0.2, 90, 72), (v) => {
    const hip = smooth(0.0, -0.3, v.y);
    v.x *= 1 + 0.08 * hip;
    v.z *= 0.88 * (v.z > 0 ? 1 + 0.1 * smooth(0.3, 0.0, Math.abs(v.y + 0.05)) : 1);
    return 1;
  }, { cell: 0.06, amp: 0.045 });
}
function armGeometry() {
  const g = capsule(0.048, 0.2, 40, 48); g.translate(0, -0.1, 0);
  return toonShape(g, (v) => { const b = 1 + 0.12 * smooth(-0.08, 0.04, v.y); v.x *= b; v.z *= b; return 1; }, { cell: 0.05, amp: 0.032 });
}
function handGeometry() {
  return toonShape(new THREE.SphereGeometry(1, 36, 28), (v) => { v.set(v.x * 0.062, v.y * 0.072, v.z * 0.058); return 0.5; }, { cell: 0.04, amp: 0.016, droop: 0.4 });
}
function legGeometry() {
  const g = capsule(0.06, 0.27, 44, 64); g.translate(0, -0.155, 0);
  return toonShape(g, (v) => { const f = 1 + 0.15 * smooth(-0.22, -0.35, v.y); v.x *= f; v.z *= f; return 1 + 0.4 * smooth(-0.27, -0.35, v.y); },
    { cell: 0.05, amp: 0.034 });
}
function footGeometry() {
  const pad = new THREE.SphereGeometry(1, 28, 18); pad.scale(0.09, 0.05, 0.085);
  const parts: THREE.BufferGeometry[] = [pad];
  for (const a of [-0.55, 0, 0.55]) {
    const toe = new THREE.CapsuleGeometry(0.036, 0.09, 8, 16);
    toe.rotateX(Math.PI / 2); toe.scale(1, 0.85, 1); toe.translate(0, -0.012, 0.075); toe.rotateY(a);
    parts.push(toe);
  }
  return toonShape(merge(parts.map((p) => { p.deleteAttribute('uv'); return p; })), () => 0, { amp: 0 });
}

// ------------------------------------------------------------------ 2D outline helpers
function roundedShape(pts: readonly P2[], r: number): THREE.Shape {
  const s = new THREE.Shape(), n = pts.length;
  for (let i = 0; i < n; i++) {
    const p = pts[i], a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n];
    const da = Math.hypot(a[0] - p[0], a[1] - p[1]), db = Math.hypot(b[0] - p[0], b[1] - p[1]);
    const ra = Math.min(r, da * 0.45), rb = Math.min(r, db * 0.45);
    const A = [p[0] + ((a[0] - p[0]) / da) * ra, p[1] + ((a[1] - p[1]) / da) * ra];
    const B = [p[0] + ((b[0] - p[0]) / db) * rb, p[1] + ((b[1] - p[1]) / db) * rb];
    if (i === 0) s.moveTo(A[0], A[1]); else s.lineTo(A[0], A[1]);
    s.quadraticCurveTo(p[0], p[1], B[0], B[1]);
  }
  s.closePath();
  return s;
}
function offsetPoly(pts: readonly P2[], d: number): P2[] {
  const n = pts.length;
  return pts.map((p, i) => {
    const a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n];
    const e1 = [p[0] - a[0], p[1] - a[1]], e2 = [b[0] - p[0], b[1] - p[1]];
    const l1 = Math.hypot(e1[0], e1[1]), l2 = Math.hypot(e2[0], e2[1]);
    const n1 = [e1[1] / l1, -e1[0] / l1], n2 = [e2[1] / l2, -e2[0] / l2];
    let m = [n1[0] + n2[0], n1[1] + n2[1]];
    const ml = Math.hypot(m[0], m[1]); m = [m[0] / ml, m[1] / ml];
    const k = d / Math.max(0.35, m[0] * n1[0] + m[1] * n1[1]);
    return [p[0] + m[0] * k, p[1] + m[1] * k] as const;
  });
}
function resample(pts: THREE.Vector2[], N: number): THREE.Vector2[] {
  const seg: number[] = []; let L = 0;
  for (let i = 0; i < pts.length; i++) { const l = pts[i].distanceTo(pts[(i + 1) % pts.length]); seg.push(l); L += l; }
  const out: THREE.Vector2[] = []; let i = 0, acc = 0;
  for (let k = 0; k < N; k++) {
    const target = (k / N) * L;
    while (acc + seg[i] < target) { acc += seg[i]; i++; }
    out.push(new THREE.Vector2().lerpVectors(pts[i], pts[(i + 1) % pts.length], seg[i] ? (target - acc) / seg[i] : 0));
  }
  return out;
}
function contour(poly: readonly P2[], r: number, N: number): THREE.Vector2[] {
  const p = roundedShape(poly, r).getPoints(8);
  if (p[0].distanceTo(p[p.length - 1]) < 1e-6) p.pop();
  if (THREE.ShapeUtils.isClockWise(p)) p.reverse();
  return resample(p, N);
}
function stripGeo(rings: number[][][]): THREE.BufferGeometry {
  const N = rings[0].length, pos: number[] = [], idx: number[] = [];
  rings.forEach((r) => r.forEach((v) => pos.push(v[0], v[1], v[2])));
  for (let r = 0; r < rings.length - 1; r++) for (let i = 0; i < N; i++) {
    const a = r * N + i, b = r * N + ((i + 1) % N), c = (r + 1) * N + i, d = (r + 1) * N + ((i + 1) % N);
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// ------------------------------------------------------------------ materials
const matWhite = toonMat(0xffffff);
const matEye = toonMat(0xffffff, 0xffffff, 0.15);
const matInk = new THREE.MeshBasicMaterial({ color: 0x07060c });
const matBeak = toonMat(0xff9419, 0xffd27a, 0.35);
const matMouth = new THREE.MeshToonMaterial({ color: 0xff3010, gradientMap: toonRamp, side: THREE.DoubleSide });
const matThroat = new THREE.MeshToonMaterial({ color: 0xa00510, gradientMap: toonRamp, polygonOffset: true, polygonOffsetFactor: -2 });
const matFoot = toonMat(0xff8d1a, 0xffd27a, 0.35);
const matBeakLight = new THREE.MeshBasicMaterial({ color: 0xffc04a, polygonOffset: true, polygonOffsetFactor: -2 });
const matTongue = toonMat(0xff6a52, 0xffb0a0, 0.3);
const matLip = new THREE.MeshBasicMaterial({ color: 0x07060c, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1 });
const matSparkle = new THREE.MeshBasicMaterial({ color: 0xffffff });

const HOLE_N = 48;
/** The head's white material with the mouth opening cut out of the front (so the mouth goes INTO the head). */
function headMaterial(): THREE.MeshToonMaterial {
  const hole = contour(offsetPoly(MOUTH, 0.012), 0.02, HOLE_N).map((p) => new THREE.Vector2(p.x + MOUTH_TOP.x, p.y + MOUTH_TOP.y));
  const m = toonMat(0xffffff);
  const prev = m.onBeforeCompile;
  m.onBeforeCompile = (s, r) => {
    prev.call(m, s, r);
    s.uniforms.uHole = { value: hole };
    s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vLocal;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLocal = position;');
    s.fragmentShader = s.fragmentShader.replace('#include <common>', `#include <common>
varying vec3 vLocal; uniform vec2 uHole[${HOLE_N}];
bool inHole(vec2 p) {
  bool c = false;
  for (int i = 0; i < ${HOLE_N}; i++) {
    int j = i == 0 ? ${HOLE_N - 1} : i - 1;
    vec2 a = uHole[i], b = uHole[j];
    if (((a.y > p.y) != (b.y > p.y)) && (p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x)) c = !c;
  }
  return c;
}`).replace('void main() {', 'void main() {\n  if (vLocal.z > 0.0 && inHole(vLocal.xy)) discard;');
  };
  m.customProgramCacheKey = () => 'toon-head-with-mouth-hole';
  return m;
}

// ------------------------------------------------------------------ the template

export interface PupilSurface {
  /** Height of the eye surface at (x, y) relative to the eye centre, for placing the moving pupil. */
  z(x: number, y: number): number;
}

export interface OwlTemplate {
  root: THREE.Group;
  pupilSurfaces: PupilSurface[];
  mandibleRest: number;
}

let template: OwlTemplate | null = null;

/** Builds (once) the full owl with named nodes. Takes a moment the first time — call it during loading. */
export function getOwlTemplate(): OwlTemplate {
  if (template) return template;

  const root = new THREE.Group(); root.name = 'owl';
  const rig = new THREE.Group(); rig.name = 'rig'; rig.scale.setScalar(RIG.scale); root.add(rig);
  const body = new THREE.Group(); body.name = 'body'; body.position.y = RIG.hip; rig.add(body);
  const torso = toonPart(torsoGeometry(), matWhite, 0.016); torso.position.y = 0.25; body.add(torso);
  (torso.children[1] as THREE.Mesh).receiveShadow = false;

  const neck = new THREE.Group(); neck.name = 'neck'; neck.position.y = 0.5; body.add(neck);
  const head = new THREE.Group(); head.name = 'head'; head.position.y = RIG.headY; head.scale.setScalar(RIG.headScale); neck.add(head);
  const headMesh = toonPart(headGeometry(140, true), headMaterial(), 0.026); head.add(headMesh);
  (headMesh.children[1] as THREE.Mesh).receiveShadow = false;
  const face = new THREE.Group(); head.add(face);

  // the face is projected onto a smooth copy of the head
  const probe = new THREE.Mesh(headGeometry(48, false));
  const ray = new THREE.Raycaster(), o = new THREE.Vector3(), dn = new THREE.Vector3(0, 0, -1);
  const hitAt = (x: number, y: number) => { ray.set(o.set(x, y, 1), dn); return ray.intersectObject(probe)[0]; };
  const surfZ = (x: number, y: number) => hitAt(x, y)?.point.z ?? 0;

  const pupilSurfaces: PupilSurface[] = EYES.map((e, idx) => {
    const dome = (x: number, y: number) => 0.006 + 0.034 * clamp(1 - (x * x + y * y) / (e.r * e.r), 0, 1);
    const z0 = surfZ(e.x, e.y);
    const grp = new THREE.Group(); grp.name = `eye${idx}`; grp.position.set(e.x, e.y, z0); face.add(grp);
    const decal = (geo: THREE.BufferGeometry, lift: (x: number, y: number) => number, mat: THREE.Material) => {
      const p = geo.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < p.count; i++) { const x = p.getX(i), y = p.getY(i); p.setXYZ(i, x, y, surfZ(e.x + x, e.y + y) - z0 + lift(x, y)); }
      geo.computeVertexNormals();
      grp.add(new THREE.Mesh(geo, mat));
    };
    decal(new THREE.RingGeometry(0, e.r - 0.01, 96, 12), dome, matEye);
    decal(new THREE.RingGeometry(e.r - RING, e.r + 0.002, 128, 3), (x, y) => dome(x, y) + 0.004, matInk);
    const pm = new THREE.Mesh(new THREE.CircleGeometry(e.pr, 32), matInk); pm.name = `pupil${idx}`;
    const sparkle = new THREE.Mesh(new THREE.CircleGeometry(e.pr * 0.32, 16), matSparkle);
    sparkle.position.set(e.pr * 0.32, e.pr * 0.34, 0.002); pm.add(sparkle);
    const n = (hitAt(e.x, e.y)?.face?.normal ?? new THREE.Vector3(0, 0, 1)).clone().lerp(new THREE.Vector3(0, 0, 1), 0.4).normalize();
    pm.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    grp.add(pm);
    // pre-sample the eye surface so moving pupils never need raycasts at runtime
    const G = 24, grid = new Float32Array((G + 1) * (G + 1));
    for (let j = 0; j <= G; j++) for (let i = 0; i <= G; i++) {
      const x = -e.r + (2 * e.r * i) / G, y = -e.r + (2 * e.r * j) / G;
      grid[j * (G + 1) + i] = surfZ(e.x + x, e.y + y) - z0 + dome(x, y) + 0.016;
    }
    return {
      z(x: number, y: number) {
        const fx = clamp(((x + e.r) / (2 * e.r)) * G, 0, G - 1e-6), fy = clamp(((y + e.r) / (2 * e.r)) * G, 0, G - 1e-6);
        const i = Math.floor(fx), j = Math.floor(fy), u = fx - i, v = fy - j, W = G + 1;
        return lerp(lerp(grid[j * W + i], grid[j * W + i + 1], u), lerp(grid[(j + 1) * W + i], grid[(j + 1) * W + i + 1], u), v);
      },
    };
  });

  // the open beak: lips flush on the face, red tunnel into the head, throat, tongue, flat upper beak
  const X = MOUTH_TOP.x, Y = MOUTH_TOP.y, N = 140;
  const at = (p: THREE.Vector2, lift: number) => [X + p.x, Y + p.y, surfZ(X + p.x, Y + p.y) + lift];
  const inner = contour(MOUTH, 0.012, N), outer = contour(offsetPoly(MOUTH, 0.034), 0.03, N);
  face.add(new THREE.Mesh(stripGeo([0, 0.5, 1].map((t) => inner.map((p, i) => at(new THREE.Vector2().lerpVectors(p, outer[i], t), 0.004)))), matLip));
  const c = inner.reduce((s, p) => s.add(p), new THREE.Vector2()).divideScalar(N);
  const shrink = (p: THREE.Vector2, k: number) => new THREE.Vector2().lerpVectors(c, p, k);
  const zBack = Math.min(...inner.map((p) => surfZ(X + p.x, Y + p.y))) - 0.07;
  face.add(new THREE.Mesh(stripGeo([0, 0.35, 0.7, 1].map((t) => inner.map((p) => {
    const q = shrink(p, 1 - 0.18 * t), top = surfZ(X + p.x, Y + p.y) + 0.004;
    return [X + q.x, Y + q.y, lerp(top, zBack, Math.sqrt(t))];
  }))), matMouth));
  const back = new THREE.Mesh(new THREE.ShapeGeometry(new THREE.Shape(inner.map((p) => shrink(p, 0.82)))), matMouth);
  back.position.set(X, Y, zBack); face.add(back);
  const throat = new THREE.Mesh(new THREE.ShapeGeometry(roundedShape(THROAT.map(([x, y]) => { const q = shrink(new THREE.Vector2(x, y), 0.82); return [q.x, q.y] as const; }), 0.02), 10), matThroat);
  throat.position.set(X, Y, zBack + 0.002); face.add(throat);
  const tongue = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), matTongue); tongue.name = 'tongue';
  const tp = shrink(new THREE.Vector2(-0.012, -0.29), 0.82);
  tongue.scale.set(0.066, 0.028, 0.04); tongue.position.set(X + tp.x, Y + tp.y, zBack + 0.01); tongue.rotation.z = 0.12; face.add(tongue);
  const upper = toonPart(new THREE.ExtrudeGeometry(roundedShape(MANDIBLE, 0.01),
    { depth: 0.022, bevelEnabled: true, bevelThickness: 0.006, bevelSize: 0.005, bevelSegments: 3, curveSegments: 10 }), matBeak, 0.007);
  upper.position.z = -0.026;
  const shine = new THREE.Mesh(new THREE.ShapeGeometry(roundedShape([[-0.006, -0.03], [-0.062, -0.15], [-0.04, -0.148], [0.0, -0.06]], 0.012), 8), matBeakLight);
  shine.position.z = 0.0285; upper.add(shine);
  const mandible = new THREE.Group(); mandible.name = 'mandible'; mandible.add(upper);
  const z0 = surfZ(X, Y - 0.005), z1 = surfZ(X - 0.02, Y - 0.17);
  mandible.position.set(X, Y, z0);
  const mandibleRest = Math.asin(clamp((z0 - z1) / 0.17, -0.9, 0.9));
  mandible.rotation.x = mandibleRest;
  face.add(mandible);

  // stubby arms, legs, orange bird feet
  const armGeo = armGeometry(), handGeo = handGeometry(), legGeo = legGeometry(), footGeo = footGeometry();
  for (const s of [-1, 1]) {
    const sh = new THREE.Group(); sh.name = `arm${s}`; sh.position.set(s * 0.205, 0.41, 0); sh.rotation.z = s * 0.12; body.add(sh);
    sh.add(toonPart(armGeo, matWhite, 0.012));
    const hand = toonPart(handGeo, matWhite, 0.011); hand.position.set(0, -0.285, 0.01); sh.add(hand);
    const hip = new THREE.Group(); hip.name = `leg${s}`; hip.position.set(s * 0.09, RIG.hip + 0.02, 0); hip.rotation.z = s * 0.04; rig.add(hip);
    hip.add(toonPart(legGeo, matWhite, 0.012));
    const foot = toonPart(footGeo, matFoot, 0.008); foot.scale.setScalar(0.9);
    foot.position.set(0, -0.38, 0.03); foot.rotation.y = s * 0.15; hip.add(foot);
  }

  template = { root, pupilSurfaces, mandibleRest };
  return template;
}
