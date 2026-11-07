import * as THREE from 'three';
import { PLOTS, PLOT_SIZE, type GraveInfo, type MemeInfo, type Plot } from '../../../shared/graves.ts';
import type { Colliders } from './collision.ts';
import { merge } from '../owl/toon.ts';

/** What the player is standing at. */
export type PlotFocus =
  | { kind: 'empty'; plot: Plot }
  | { kind: 'reserved'; plot: Plot }
  | { kind: 'grave'; plot: Plot; grave: GraveInfo };

interface PlotView {
  plot: Plot;
  group: THREE.Group;
  emptyBits: THREE.Object3D[];   // sign + mound, hidden once a grave is placed
  grave: GraveInfo | null;
  graveObj: THREE.Object3D | null;
}

const NEAR_RANGE = 1.0;   // how far outside the plot rectangle still counts as "at" the plot (rows are 1.6 m apart; nearest wins)

/**
 * The 40 grave plots: empty ones (dirt bed + "YOUR BAGS HERE" sign), real graves built from server data
 * (four tombstone tiers showing the meme logo, ticker and name), and the highlight around the plot the
 * player is standing at.
 */
export class GraveField {
  private readonly scene: THREE.Scene;
  private readonly colliders: Colliders;
  private readonly views: PlotView[];
  private reserved = new Set<number>();
  private readonly highlight: THREE.Group;
  private readonly glowMat: THREE.MeshBasicMaterial;
  private readonly frameMat: THREE.MeshBasicMaterial;
  private readonly mats: ReturnType<typeof makeMaterials>;
  private focusId: number | null = null;

  constructor(scene: THREE.Scene, colliders: Colliders, stone: THREE.MeshStandardMaterial[], iron: THREE.MeshStandardMaterial) {
    this.scene = scene;
    this.colliders = colliders;
    this.mats = makeMaterials(stone, iron);
    const g = sharedGeometry();
    const signTex = labelTexture(['YOUR BAGS', 'HERE'], { w: 256, h: 112, color: '#2a1d12', font: '700 34px Georgia, serif', bg: '#b08a5a' });
    const signMat = new THREE.MeshStandardMaterial({ map: signTex, roughness: 0.9 });
    this.views = PLOTS.map((plot) => {
      const group = new THREE.Group();
      group.position.set(plot.x, 0, plot.z);
      const bed = new THREE.Mesh(g.bed, this.mats.soil); bed.position.y = 0.03; bed.receiveShadow = true;
      const curb = new THREE.Mesh(g.curb, stone[1]); curb.castShadow = curb.receiveShadow = true;
      const mound = new THREE.Mesh(g.mound, this.mats.soilLight); mound.position.set(0, 0.04, 0.15); mound.receiveShadow = true;
      const post = new THREE.Mesh(g.post, this.mats.wood); post.position.set(0.32, 0.34, -0.95); post.castShadow = true;
      const sign = new THREE.Mesh(g.sign, signMat); sign.position.set(0.32, 0.6, -0.93); sign.rotation.z = -0.06;
      group.add(bed, curb, mound, post, sign);
      scene.add(group);
      return { plot, group, emptyBits: [mound, post, sign], grave: null, graveObj: null };
    });

    // highlight: a glowing frame + soft glow on the ground around the whole plot
    this.glowMat = new THREE.MeshBasicMaterial({ color: 0xf1c76b, transparent: true, opacity: 0.18, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
    this.frameMat = new THREE.MeshBasicMaterial({ color: 0xf1c76b, transparent: true, opacity: 0.9, depthWrite: false, toneMapped: false });
    this.highlight = new THREE.Group();
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(PLOT_SIZE.w + 0.5, PLOT_SIZE.d + 0.5), this.glowMat);
    glow.rotation.x = -Math.PI / 2; glow.position.y = 0.025; glow.renderOrder = 2;
    const fw = PLOT_SIZE.w + 0.4, fd = PLOT_SIZE.d + 0.4, t = 0.05;
    const bars = [
      [fw, t, 0, -fd / 2], [fw, t, 0, fd / 2], [t, fd, -fw / 2, 0], [t, fd, fw / 2, 0],
    ].map(([w, d, x, z]) => { const b = new THREE.BoxGeometry(w, 0.03, d); b.translate(x, 0.04, z); return b; });
    const frame = new THREE.Mesh(merge(bars), this.frameMat); frame.renderOrder = 3;
    this.highlight.add(glow, frame);
    this.highlight.visible = false;
    scene.add(this.highlight);
  }

  /** Replaces all graves (initial load / reconnect). */
  setGraves(graves: GraveInfo[]): void {
    for (const v of this.views) if (v.grave && !graves.some((g) => g.plot === v.plot.id)) this.clearGrave(v);
    for (const g of graves) this.addGrave(g);
  }

  addGrave(g: GraveInfo): void {
    const v = this.views[g.plot - 1];
    if (!v || (v.grave && v.grave.id === g.id)) return;
    if (v.graveObj) this.clearGrave(v);
    v.grave = g;
    v.graveObj = buildGrave(g, this.mats);
    v.group.add(v.graveObj);
    for (const b of v.emptyBits) b.visible = false;
    const r = [0.25, 0.42, 0.58, 0.85][g.tier - 1];
    this.colliders.circles.push({ x: v.plot.x, z: v.plot.z + (g.tier === 4 ? -0.3 : -0.75), r, ...{ graveId: g.id } } as Colliders['circles'][number]);
  }

  setReserved(plots: number[]): void { this.reserved = new Set(plots); }

  graves(): GraveInfo[] { return this.views.flatMap((v) => (v.grave ? [v.grave] : [])); }

  /** The plot the player is at (inside the plot or just around it), nearest first. */
  focusAt(p: THREE.Vector3): PlotFocus | null {
    let best: PlotView | null = null, bestD = Infinity;
    for (const v of this.views) {
      const dx = Math.abs(p.x - v.plot.x), dz = Math.abs(p.z - v.plot.z);
      if (dx > PLOT_SIZE.w / 2 + NEAR_RANGE || dz > PLOT_SIZE.d / 2 + NEAR_RANGE) continue;
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = v; }
    }
    if (!best) return null;
    if (best.grave) return { kind: 'grave', plot: best.plot, grave: best.grave };
    return this.reserved.has(best.plot.id) ? { kind: 'reserved', plot: best.plot } : { kind: 'empty', plot: best.plot };
  }

  /** Per frame: move/pulse the highlight onto the focused plot. */
  update(t: number, focus: PlotFocus | null): void {
    this.highlight.visible = !!focus;
    if (!focus) { this.focusId = null; return; }
    if (this.focusId !== focus.plot.id) {
      this.focusId = focus.plot.id;
      this.highlight.position.set(focus.plot.x, 0, focus.plot.z);
    }
    const color = focus.kind === 'empty' ? 0xf1c76b : focus.kind === 'reserved' ? 0xe0705f : 0xbcd2ff;
    this.glowMat.color.setHex(color); this.frameMat.color.setHex(color);
    const pulse = 0.5 + 0.5 * Math.sin(t * 3.2);
    this.glowMat.opacity = focus.kind === 'empty' ? 0.14 + pulse * 0.16 : 0.1 + pulse * 0.06;
    this.frameMat.opacity = 0.55 + pulse * 0.4;
  }

  private clearGrave(v: PlotView) {
    if (v.graveObj) v.group.remove(v.graveObj);
    const id = v.grave?.id;
    const i = this.colliders.circles.findIndex((c) => (c as { graveId?: number }).graveId === id);
    if (i >= 0) this.colliders.circles.splice(i, 1);
    v.grave = null; v.graveObj = null;
    for (const b of v.emptyBits) b.visible = true;
  }
}

// ------------------------------------------------------------------ shared pieces

let geoCache: ReturnType<typeof buildSharedGeometry> | null = null;
const sharedGeometry = () => (geoCache ??= buildSharedGeometry());
function buildSharedGeometry() {
  const W = PLOT_SIZE.w, D = PLOT_SIZE.d;
  const curbParts = [
    [W, 0.12, 0, -D / 2 + 0.05], [W, 0.12, 0, D / 2 - 0.05], [0.1, D - 0.1, -W / 2 + 0.05, 0], [0.1, D - 0.1, W / 2 - 0.05, 0],
  ].map(([w, d, x, z]) => { const b = new THREE.BoxGeometry(w, 0.1, d); b.translate(x, 0.05, z); return b; });
  const mound = new THREE.SphereGeometry(1, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2); mound.scale(0.5, 0.14, 0.82);
  return {
    bed: new THREE.BoxGeometry(W - 0.1, 0.05, D - 0.1),
    curb: merge(curbParts),
    mound,
    post: new THREE.BoxGeometry(0.05, 0.68, 0.05),
    sign: new THREE.PlaneGeometry(0.46, 0.2),
  };
}

function makeMaterials(stone: THREE.MeshStandardMaterial[], iron: THREE.MeshStandardMaterial) {
  return {
    stone, iron,
    soil: new THREE.MeshStandardMaterial({ color: 0x33251c, roughness: 1 }),
    soilLight: new THREE.MeshStandardMaterial({ color: 0x4a3627, roughness: 1 }),
    wood: new THREE.MeshStandardMaterial({ color: 0x6b4a2e, roughness: 0.9 }),
    marble: new THREE.MeshStandardMaterial({ color: 0x2c2933, roughness: 0.35, metalness: 0.1 }),
    gold: new THREE.MeshStandardMaterial({ color: 0xd9a743, roughness: 0.35, metalness: 0.85, emissive: 0x3a2808 }),
    flame: new THREE.MeshBasicMaterial({ color: 0xffc46b, toneMapped: false }),
  };
}

/** Text on a canvas texture (engraved or painted). */
function labelTexture(lines: string[], o: { w: number; h: number; color: string; font: string; bg?: string; shadow?: string }): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = o.w; c.height = o.h;
  const g = c.getContext('2d')!;
  if (o.bg) { g.fillStyle = o.bg; g.fillRect(0, 0, o.w, o.h); }
  g.font = o.font; g.textAlign = 'center'; g.textBaseline = 'middle';
  const lh = o.h / (lines.length + 0.4);
  lines.forEach((ln, i) => {
    const y = lh * (i + 0.7);
    let text = ln;
    while (g.measureText(text).width > o.w * 0.92 && text.length > 1) text = text.slice(0, -2) + '…';
    if (o.shadow) { g.fillStyle = o.shadow; g.fillText(text, o.w / 2 + 2, y + 2); }
    g.fillStyle = o.color; g.fillText(text, o.w / 2, y);
  });
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

const iconCache = new Map<string, THREE.CanvasTexture>();
/** Round meme logo texture. Starts as a lettered placeholder and swaps in the real logo once decoded. */
function iconTexture(meme: MemeInfo): THREE.CanvasTexture {
  const key = `${meme.chain}:${meme.contract}`;
  const hit = iconCache.get(key);
  if (hit) return hit;
  const S = 256, c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const placeholder = () => {
    g.clearRect(0, 0, S, S);
    g.fillStyle = '#3b3846'; g.beginPath(); g.arc(S / 2, S / 2, S / 2, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#ecebe6'; g.font = '800 120px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText((meme.symbol || '?').slice(0, 1).toUpperCase(), S / 2, S / 2 + 6);
    tex.needsUpdate = true;
  };
  placeholder();
  if (meme.icon) {
    const img = new Image();
    img.onload = () => {
      g.clearRect(0, 0, S, S);
      g.save(); g.beginPath(); g.arc(S / 2, S / 2, S / 2, 0, Math.PI * 2); g.clip();
      g.fillStyle = '#ffffff'; g.fillRect(0, 0, S, S);
      g.drawImage(img, 0, 0, S, S);
      g.restore();
      tex.needsUpdate = true;
    };
    img.src = meme.icon;   // data: URI validated by the server
  }
  iconCache.set(key, tex);
  return tex;
}

function archGeo(w: number, h: number, d: number) {
  const s = new THREE.Shape(); s.moveTo(-w / 2, 0); s.lineTo(w / 2, 0); s.lineTo(w / 2, h - w / 2);
  s.absarc(0, h - w / 2, w / 2, 0, Math.PI, false); s.lineTo(-w / 2, 0);
  const g = new THREE.ExtrudeGeometry(s, { depth: d, bevelEnabled: true, bevelThickness: 0.025, bevelSize: 0.025, bevelSegments: 2, curveSegments: 24 });
  g.translate(0, 0, -d / 2);
  return g;
}

/** Builds the tombstone for a grave. Origin = plot centre; the stone stands at the back, facing +z. */
function buildGrave(g: GraveInfo, m: ReturnType<typeof makeMaterials>): THREE.Group {
  const root = new THREE.Group();
  const icon = new THREE.MeshBasicMaterial({ map: iconTexture(g.meme) });
  const sym = (g.meme.symbol || g.meme.name).toUpperCase();
  const add = (o: THREE.Mesh, x: number, y: number, z: number) => { o.position.set(x, y, z); o.castShadow = true; o.receiveShadow = true; root.add(o); return o; };
  const plane = (w: number, h: number, mat: THREE.Material) => new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  const engraved = (lines: string[], gold = false) => new THREE.MeshStandardMaterial({
    map: labelTexture(lines, { w: 512, h: 160, color: gold ? '#f0c768' : '#25222c', shadow: gold ? 'rgba(0,0,0,.6)' : 'rgba(230,228,240,.35)', font: '700 64px Georgia, serif' }),
    transparent: true, roughness: 1, polygonOffset: true, polygonOffsetFactor: -2,
  });
  const mound = new THREE.Mesh(sharedGeometry().mound, m.soilLight);
  mound.position.set(0, 0.04, 0.2); mound.receiveShadow = true; root.add(mound);
  const Z = -0.75;

  if (g.tier === 1) {                                          // $1 — wooden cross with the logo nailed on
    add(new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.05, 0.08), m.wood), 0, 0.52, Z);
    add(new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.1, 0.08), m.wood), 0, 0.74, Z);
    add(new THREE.Mesh(new THREE.CircleGeometry(0.15, 40), icon), 0, 0.74, Z + 0.045);
    const plank = add(new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.15, 0.03), m.wood), 0, 0.33, Z + 0.06);
    plank.rotation.z = 0.05;
    add(plane(0.46, 0.14, engraved([sym])), 0, 0.33, Z + 0.077).rotation.z = 0.05;
  } else if (g.tier === 2) {                                   // $5 — classic rounded headstone
    add(new THREE.Mesh(archGeo(0.72, 1.02, 0.14), m.stone[0]), 0, 0, Z);
    add(new THREE.Mesh(new THREE.CircleGeometry(0.2, 48), icon), 0, 0.64, Z + 0.1);
    add(plane(0.64, 0.2, engraved([sym])), 0, 0.32, Z + 0.1);
    add(plane(0.4, 0.12, engraved(['R.I.P.'])), 0, 0.92, Z + 0.1);
    add(new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.1, 1.5), m.stone[2]), 0, 0.05, 0.2);
  } else if (g.tier === 3) {                                   // $10 — grand marble tombstone with gold and candles
    add(new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.24, 0.45), m.marble), 0, 0.12, Z);
    add(new THREE.Mesh(archGeo(0.96, 1.34, 0.16), m.marble), 0, 0.24, Z);
    add(new THREE.Mesh(new THREE.TorusGeometry(0.27, 0.025, 10, 48), m.gold), 0, 1.1, Z + 0.11);
    add(new THREE.Mesh(new THREE.CircleGeometry(0.25, 48), icon), 0, 1.1, Z + 0.11);
    add(plane(0.86, 0.27, engraved([sym], true)), 0, 0.66, Z + 0.11);
    add(plane(0.8, 0.2, engraved([g.meme.name], true)), 0, 0.45, Z + 0.11);
    add(new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.14, 1.75), m.marble), 0, 0.07, 0.25);
    for (const s of [-1, 1]) {
      add(new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.04, 0.2, 10), m.gold), s * 0.48, 0.34, Z + 0.12);
      add(new THREE.Mesh(new THREE.SphereGeometry(0.03, 10, 8), m.flame), s * 0.48, 0.47, Z + 0.12).scale.y = 1.6;
    }
  } else {                                                     // $50 — a little mausoleum
    add(new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.2, 2.2), m.stone[2]), 0, 0.1, 0);
    add(new THREE.Mesh(new THREE.BoxGeometry(1.32, 1.65, 0.2), m.marble), 0, 1.02, -0.92);
    for (const x of [-0.6, 0.6]) for (const z of [-0.6, 0.55]) add(new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.09, 1.65, 14), m.stone[0]), x, 1.02, z);
    add(new THREE.Mesh(new THREE.BoxGeometry(1.56, 0.14, 2.0), m.stone[3]), 0, 1.92, -0.15);
    const tri = new THREE.Shape(); tri.moveTo(-0.8, 0); tri.lineTo(0.8, 0); tri.lineTo(0, 0.42); tri.lineTo(-0.8, 0);
    const ped = add(new THREE.Mesh(new THREE.ExtrudeGeometry(tri, { depth: 2.0, bevelEnabled: false }), m.stone[3]), 0, 1.99, -1.15);
    ped.castShadow = true;
    add(new THREE.Mesh(new THREE.TorusGeometry(0.37, 0.035, 12, 56), m.gold), 0, 1.15, -0.81);
    add(new THREE.Mesh(new THREE.CircleGeometry(0.35, 56), icon), 0, 1.15, -0.81);
    add(plane(1.1, 0.3, engraved([sym], true)), 0, 0.5, -0.81);
    add(plane(1.0, 0.24, engraved([g.meme.name], true)), 0, 2.13, 0.86);
    add(new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.05, 0.05), m.gold), 0, 1.86, 0.86);
    for (const s of [-1, 1]) {
      add(new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 0.18, 10), m.gold), s * 0.6, 0.29, 0.9);
      add(new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 8), m.flame), s * 0.6, 0.43, 0.9).scale.y = 1.6;
    }
  }
  return root;
}
