import * as THREE from 'three';
import { DecalGeometry } from 'three/examples/jsm/geometries/DecalGeometry.js';
import type { GraveInfo } from '../../../shared/graves.ts';
import type { Owl } from '../owl/owl.ts';

/**
 * NPC owls are ghosts: 50-80% opaque with a pale blue tint, each wearing a dead coin's logo (from a real grave here)
 * printed on its chest. Ghost materials are made once per original material and opacity level, and shared.
 */
export const GHOST_LEVELS = [0.5, 0.6, 0.7, 0.8] as const;
const TINT = new THREE.Color(0xc9e6ff);
const ghostMats = new Map<string, THREE.Material>();
const matIds = new WeakMap<THREE.Material, number>();
let nextMatId = 1;

function ghostMat(m: THREE.Material, alpha: number): THREE.Material {
  let id = matIds.get(m);
  if (!id) { id = nextMatId++; matIds.set(m, id); }
  const key = `${id}:${alpha}`;
  const hit = ghostMats.get(key);
  if (hit) return hit;
  const g = m.clone();
  // clone() drops the shader tweaks (rim light, outline hull); keep them
  g.onBeforeCompile = m.onBeforeCompile;
  g.customProgramCacheKey = m.customProgramCacheKey;
  g.transparent = alpha < 1;
  const outline = m.side === THREE.BackSide;
  g.opacity = alpha < 1 ? m.opacity * (outline ? alpha * 0.7 : alpha) : m.opacity;
  if (!outline && 'color' in g && g.color instanceof THREE.Color) g.color.lerp(TINT, 0.3);
  // a faint pale-blue glow so they read as ghosts, not grey owls, against the dark ground
  if (!outline && 'emissive' in g && g.emissive instanceof THREE.Color) g.emissive.set(0x6f8fb8).multiplyScalar(0.35);
  ghostMats.set(key, g);
  return g;
}

/** Turns an owl into a ghost of the given opacity (call once, right after createOwl). */
export function ghostify(owl: Owl, alpha: number): void {
  owl.root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    o.material = Array.isArray(o.material) ? o.material.map((m) => ghostMat(m, alpha)) : ghostMat(o.material, alpha);
    o.castShadow = false;
  });
}

// ------------------------------------------------------------------ coin logo, printed on the chest

/** The torso: the first part on the body, a [outline, mesh] pair (see model.ts). */
function torsoMesh(owl: Owl): THREE.Mesh | null {
  const torso = owl.root.getObjectByName('body')?.children[0];
  const mesh = torso?.children[1];
  return mesh instanceof THREE.Mesh ? mesh : null;
}

/** One decal shape for every owl (they share the torso geometry): it hugs the chest, fur bumps and all. */
let decalGeo: THREE.BufferGeometry | null = null;
function chestDecal(torso: THREE.Mesh): THREE.BufferGeometry {
  if (decalGeo) return decalGeo;
  const probe = new THREE.Mesh(torso.geometry);
  probe.updateMatrixWorld(true);   // identity: the decal comes out in torso space
  decalGeo = new DecalGeometry(probe, new THREE.Vector3(0, -0.02, 0.2), new THREE.Euler(0, 0, 0), new THREE.Vector3(0.17, 0.17, 0.4));
  return decalGeo;
}

/** The logo as a round coin: the image (or the ticker's first letter) in a circle with a thin gold ring. */
function coinTexture(g: GraveInfo): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const x = c.getContext('2d')!;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const draw = (img: HTMLImageElement | null) => {
    x.clearRect(0, 0, 128, 128);
    x.save(); x.beginPath(); x.arc(64, 64, 58, 0, Math.PI * 2); x.clip();
    if (img) x.drawImage(img, 6, 6, 116, 116);
    else {
      x.fillStyle = '#2e2b38'; x.fillRect(0, 0, 128, 128);
      x.fillStyle = '#ffffff'; x.font = '900 66px Arial Black, Arial, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
      x.fillText((g.meme.symbol || '?').slice(0, 1).toUpperCase(), 64, 68);
    }
    x.restore();
    x.lineWidth = 6; x.strokeStyle = '#f1c76b'; x.beginPath(); x.arc(64, 64, 58, 0, Math.PI * 2); x.stroke();
    tex.needsUpdate = true;
  };
  draw(null);
  if (g.meme.icon) {
    const img = new Image();
    img.onload = () => draw(img);
    img.src = g.meme.icon;   // data: URI from our own server
  }
  return tex;
}

const coinTex = new Map<string, THREE.CanvasTexture>();
const coinMats = new Map<string, THREE.MeshBasicMaterial>();
function coinMat(g: GraveInfo, alpha: number): THREE.MeshBasicMaterial {
  const key = `${g.meme.chain}:${g.meme.contract}`;
  let tex = coinTex.get(key);
  if (!tex) { tex = coinTexture(g); coinTex.set(key, tex); }
  let m = coinMats.get(`${key}:${alpha}`);
  if (!m) {
    m = new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: alpha, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 });
    coinMats.set(`${key}:${alpha}`, m);
  }
  return m;
}

/** Prints a grave's coin logo on the owl's chest; it follows the body's shape, so nothing sticks out. */
export function addCoinBadge(owl: Owl, grave: GraveInfo, alpha: number): void {
  const torso = torsoMesh(owl);
  if (!torso?.parent) return;
  const decal = new THREE.Mesh(chestDecal(torso), coinMat(grave, alpha));
  decal.name = 'coin-badge';
  decal.position.copy(torso.position); decal.rotation.copy(torso.rotation); decal.scale.copy(torso.scale);
  decal.renderOrder = 1;
  torso.parent.add(decal);
}

// ------------------------------------------------------------------ appearing and vanishing

/**
 * While one ghost fades in or out it gets its own copies of the (shared) ghost materials, so only it changes
 * opacity; when it is done they are dropped again. Copies keep the shader tweaks, so they reuse the same programs.
 */
export class GhostFade {
  private readonly swaps: { mesh: THREE.Mesh; shared: THREE.Material | THREE.Material[]; own: THREE.Material[]; base: number[] }[] = [];

  constructor(owl: Owl) {
    owl.root.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      const shared = o.material;
      const list = Array.isArray(shared) ? shared : [shared];
      const own = list.map((m) => {
        const c = m.clone();
        c.onBeforeCompile = m.onBeforeCompile;
        c.customProgramCacheKey = m.customProgramCacheKey;
        c.transparent = true;
        return c;
      });
      this.swaps.push({ mesh: o, shared, own, base: list.map((m) => m.opacity) });
      o.material = Array.isArray(shared) ? own : own[0];
    });
  }

  /** 0 = gone, 1 = fully there. */
  set(k: number): void {
    for (const s of this.swaps) s.own.forEach((m, i) => { m.opacity = s.base[i] * k; m.visible = k > 0.01; });
  }

  /** Back to the shared materials (after fading in), freeing the copies. */
  restore(): void {
    for (const s of this.swaps) { s.mesh.material = s.shared; for (const m of s.own) m.dispose(); }
    this.swaps.length = 0;
  }

  dispose(): void { for (const s of this.swaps) for (const m of s.own) m.dispose(); this.swaps.length = 0; }
}
