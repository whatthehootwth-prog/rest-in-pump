import * as THREE from 'three';
import type { GraveInfo } from '../../../shared/graves.ts';
import type { Owl } from '../owl/owl.ts';

/**
 * NPC owls are ghosts: 80% opaque with a pale blue tint, and some wear a dead coin's logo (from a real grave here)
 * as a badge on their chest. Ghost materials are made once per original material and shared by every ghost.
 */
const OPACITY = 0.8;
const TINT = new THREE.Color(0xc9e6ff);
const ghostMats = new Map<THREE.Material, THREE.Material>();

function ghostMat(m: THREE.Material): THREE.Material {
  const hit = ghostMats.get(m);
  if (hit) return hit;
  const g = m.clone();
  // clone() drops the shader tweaks (rim light, outline hull); keep them
  g.onBeforeCompile = m.onBeforeCompile;
  g.customProgramCacheKey = m.customProgramCacheKey;
  g.transparent = true;
  const outline = m.side === THREE.BackSide;
  g.opacity = m.opacity * (outline ? 0.55 : OPACITY);
  if (!outline && 'color' in g && g.color instanceof THREE.Color) g.color.lerp(TINT, 0.3);
  // a faint pale-blue glow so they read as ghosts, not grey owls, against the dark ground
  if (!outline && 'emissive' in g && g.emissive instanceof THREE.Color) g.emissive.set(0x6f8fb8).multiplyScalar(0.35);
  ghostMats.set(m, g);
  return g;
}

/** Turns an owl into a ghost (call once, right after createOwl). */
export function ghostify(owl: Owl): void {
  owl.root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    o.material = Array.isArray(o.material) ? o.material.map(ghostMat) : ghostMat(o.material);
    o.castShadow = false;
  });
}

// ------------------------------------------------------------------ coin badge

const badgeGeo = new THREE.CircleGeometry(0.075, 40);
const rimGeo = new THREE.CircleGeometry(0.09, 40);
const rimMat = new THREE.MeshBasicMaterial({ color: 0xf1c76b, transparent: true, opacity: OPACITY });
const logoMats = new Map<string, THREE.MeshBasicMaterial>();

function letterTexture(symbol: string): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const x = c.getContext('2d')!;
  x.fillStyle = '#2e2b38'; x.fillRect(0, 0, 128, 128);
  x.fillStyle = '#ffffff'; x.font = '900 72px Arial Black, Arial, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillText((symbol || '?').slice(0, 1).toUpperCase(), 64, 70);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function logoMat(g: GraveInfo): THREE.MeshBasicMaterial {
  const key = `${g.meme.chain}:${g.meme.contract}`;
  let m = logoMats.get(key);
  if (m) return m;
  let tex: THREE.Texture;
  if (g.meme.icon) {
    tex = new THREE.TextureLoader().load(g.meme.icon);   // data: URI from our own server
    tex.colorSpace = THREE.SRGBColorSpace;
  } else {
    tex = letterTexture(g.meme.symbol);
  }
  m = new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: OPACITY, polygonOffset: true, polygonOffsetFactor: -1 });
  logoMats.set(key, m);
  return m;
}

/** Pins a grave's coin logo on the owl's chest (a gold-rimmed badge that moves with the body). */
export function addCoinBadge(owl: Owl, grave: GraveInfo): void {
  const body = owl.root.getObjectByName('body');
  if (!body) return;
  const badge = new THREE.Group();
  badge.name = 'coin-badge';
  const rim = new THREE.Mesh(rimGeo, rimMat);
  const logo = new THREE.Mesh(badgeGeo, logoMat(grave));
  logo.position.z = 0.002;
  badge.add(rim, logo);
  badge.position.set(0, 0.24, 0.205);   // front of the torso (owls face +z)
  badge.rotation.x = -0.12;
  body.add(badge);
}
