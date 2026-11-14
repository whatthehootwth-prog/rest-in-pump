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
 * The 40 grave plots: empty ones (dirt bed + "NO MEME BURIED. YET." sign), real graves built from server data
 * (the tombstone grows with the grave's memorial level and shows the meme logo, ticker and name, with the
 * latest offerings laid in front), and the highlight around the plot the player is standing at.
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
    const signTex = labelTexture(['NO MEME', 'BURIED.', 'YET.'], { w: 256, h: 112, color: '#2a1d12', font: '700 27px Georgia, serif', bg: '#b08a5a' });
    const signMat = new THREE.MeshStandardMaterial({ map: signTex, roughness: 0.9 });
    this.views = PLOTS.map((plot) => {
      const group = new THREE.Group();
      group.position.set(plot.x, 0, plot.z);
      const bed = new THREE.Mesh(g.bed, this.mats.soil); bed.position.y = 0.03; bed.receiveShadow = true;
      const curb = new THREE.Mesh(g.curb, stone[1]); curb.castShadow = curb.receiveShadow = true;
      const mound = new THREE.Mesh(g.mound, this.mats.soilLight); mound.position.set(0, 0.04, 0.15); mound.receiveShadow = true;
      const post = new THREE.Mesh(g.post, this.mats.wood); post.position.set(0.32, 0.34, -0.99); post.castShadow = true;
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

  /** Adds a grave, or rebuilds it when its level or offerings changed. */
  addGrave(g: GraveInfo): void {
    const v = this.views[g.plot - 1];
    if (!v) return;
    if (v.grave && v.grave.id === g.id && v.grave.level === g.level && JSON.stringify(v.grave.itemCounts ?? {}) === JSON.stringify(g.itemCounts ?? {}) && v.grave.recentItems.join() === g.recentItems.join()) {
      v.grave = g;   // only the count changed
      return;
    }
    if (v.graveObj) this.clearGrave(v);
    v.grave = g;
    v.graveObj = buildGrave(g, this.mats);
    v.group.add(v.graveObj);
    for (const b of v.emptyBits) b.visible = false;
    const r = [0.25, 0.42, 0.58, 0.85][g.level - 1];
    this.colliders.circles.push({ x: v.plot.x, z: v.plot.z + (g.level === 4 ? -0.3 : -0.75), r, ...{ graveId: g.id } } as Colliders['circles'][number]);
  }

  /** The 3D grave standing on a plot, if any (the ?film page animates it). */
  graveObject(plot: number): THREE.Object3D | null { return this.views[plot - 1]?.graveObj ?? null; }

  grave(id: number): GraveInfo | null { return this.views.find((v) => v.grave?.id === id)?.grave ?? null; }

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
    if (v.graveObj) { v.group.remove(v.graveObj); disposeGrave(v.graveObj); }
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
    wax: new THREE.MeshStandardMaterial({ color: 0xefe6cf, roughness: 0.8 }),
    petal: new THREE.MeshStandardMaterial({ color: 0xe2557a, roughness: 0.7 }),
    petal2: new THREE.MeshStandardMaterial({ color: 0xf1c84b, roughness: 0.7 }),
    stem: new THREE.MeshStandardMaterial({ color: 0x5c8f4e, roughness: 0.9 }),
    cup: new THREE.MeshStandardMaterial({ color: 0xf4f1ea, roughness: 0.6 }),
    cupBand: new THREE.MeshStandardMaterial({ color: 0xd6453d, roughness: 0.6 }),
    rug: new THREE.MeshStandardMaterial({ color: 0xa3403a, roughness: 1 }),
    rugStripe: new THREE.MeshStandardMaterial({ color: 0xe8c35a, roughness: 1 }),
    diamond: new THREE.MeshStandardMaterial({ color: 0x7fd3e8, roughness: 0.15, metalness: 0.3, emissive: 0x123844 }),
    tank: new THREE.MeshStandardMaterial({ color: 0x6fae5d, roughness: 0.5, metalness: 0.3 }),
    steel: new THREE.MeshStandardMaterial({ color: 0x8a8a8a, roughness: 0.4, metalness: 0.7 }),
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
  root.userData.owned = [icon] as THREE.Material[];   // per-grave materials, disposed with the grave
  const own = <T extends THREE.Material>(mat: T): T => { (root.userData.owned as THREE.Material[]).push(mat); return mat; };
  const sym = (g.meme.symbol || g.meme.name).toUpperCase();
  const add = (o: THREE.Mesh, x: number, y: number, z: number) => { o.position.set(x, y, z); o.castShadow = true; o.receiveShadow = true; root.add(o); return o; };
  const plane = (w: number, h: number, mat: THREE.Material) => new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  const engraved = (lines: string[], gold = false) => own(new THREE.MeshStandardMaterial({
    map: labelTexture(lines, { w: 512, h: 160, color: gold ? '#f0c768' : '#25222c', shadow: gold ? 'rgba(0,0,0,.6)' : 'rgba(230,228,240,.35)', font: '700 64px Georgia, serif' }),
    transparent: true, roughness: 1, polygonOffset: true, polygonOffsetFactor: -2,
  }));
  const mound = new THREE.Mesh(sharedGeometry().mound, m.soilLight);
  mound.position.set(0, 0.04, 0.2); mound.receiveShadow = true; mound.userData.shared = true; root.add(mound);
  const Z = -0.75;
  addOfferings(root, g, m);

  if (g.level === 1) {                                         // Forgotten — a wooden cross with the logo nailed on
    add(new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.05, 0.08), m.wood), 0, 0.52, Z);
    add(new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.1, 0.08), m.wood), 0, 0.74, Z);
    add(new THREE.Mesh(new THREE.CircleGeometry(0.15, 40), icon), 0, 0.74, Z + 0.045);
    const plank = add(new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.15, 0.03), m.wood), 0, 0.33, Z + 0.06);
    plank.rotation.z = 0.05;
    add(plane(0.46, 0.14, engraved([sym])), 0, 0.33, Z + 0.077).rotation.z = 0.05;
  } else if (g.level === 2) {                                  // Remembered — a classic rounded headstone
    add(new THREE.Mesh(archGeo(0.72, 1.02, 0.14), m.stone[0]), 0, 0, Z);
    add(new THREE.Mesh(new THREE.CircleGeometry(0.2, 48), icon), 0, 0.64, Z + 0.1);
    add(plane(0.64, 0.2, engraved([sym])), 0, 0.32, Z + 0.1);
    add(plane(0.4, 0.12, engraved(['R.I.P.'])), 0, 0.92, Z + 0.1);
    add(new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.1, 1.5), m.stone[2]), 0, 0.05, 0.2);
  } else if (g.level === 3) {                                  // Honored — a grand marble tombstone with gold and candles
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
  } else {                                                     // Legendary — a little mausoleum
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

/** Frees a removed grave's GPU resources (its own geometry and text materials; shared ones stay). */
function disposeGrave(root: THREE.Object3D) {
  root.traverse((o) => {
    if (o instanceof THREE.Mesh && !o.userData.shared) o.geometry.dispose();
  });
  const icons = new Set<THREE.Texture>(iconCache.values());
  for (const mat of (root.userData.owned as THREE.Material[] | undefined) ?? []) {
    const map = (mat as THREE.MeshStandardMaterial).map;
    if (map && !icons.has(map)) map.dispose();
    mat.dispose();
  }
}

/**
 * How many props a pile shows for a number of offerings: one each at first, then it keeps growing but slower
 * (3 -> 3, 12 -> 11, 48 -> 19, 400 -> 31, 3000 -> 43), capped by the grave's level so a popular grave stays cheap
 * to draw (all props are merged, so the cost is in vertices, not draw calls).
 */
export function pileSize(count: number, level: number): number {
  if (count <= 0) return 0;
  if (count <= 3) return count;
  return Math.min(PILE_CAP[level - 1] ?? 44, Math.round(3 + 4 * Math.log2(count / 3)));
}
const PILE_CAP = [8, 16, 28, 44];
/** How many of a pile fit on the grave itself; the rest spills onto the grass around it. */
const ON_GRAVE = 14;

/**
 * The offerings at a grave: one pile per item, growing with how many times it was offered. Flowers spread into a
 * flower bed, candles form rings round the stone, noodle cups stack into towers, rugs pile up, diamonds scatter,
 * copium tanks line up. Positions are seeded by the grave, so every player sees the same piles. All props are
 * merged into one mesh per material, so even a huge pile costs only a few draw calls.
 */
function addOfferings(root: THREE.Group, g: GraveInfo, m: ReturnType<typeof makeMaterials>) {
  const counts: Record<string, number> = { ...(g.itemCounts ?? {}) };
  for (const it of g.recentItems) if (!counts[it]) counts[it] = 1;   // older data without counts
  // where the floor is, and the free area in front of the stone, per level
  const floor = [0.06, 0.1, 0.14, 0.2][g.level - 1];
  const zFront = [-0.55, -0.55, -0.45, 0.25][g.level - 1];   // just in front of the stone / inside the mausoleum
  const zEdge = g.level === 4 ? 1.02 : 1.05;
  let seed = g.id * 9301 + 49297;
  const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
  const tmp = new THREE.Group();
  const place = (item: string, x: number, y: number, z: number, rot = rnd() * Math.PI * 2, scale = 1) => {
    const p = offeringProp(item, m);
    if (!p) return;
    p.position.set(x, y, z); p.rotation.y = rot; p.scale.setScalar(scale);
    tmp.add(p);
  };

  const n = (item: string) => pileSize(counts[item] ?? 0, g.level);
  /** A spot on the grass just outside the plot (or the mausoleum base), mostly at the front and sides. */
  const spill = (): [number, number] => {
    const hx = 0.94 + rnd() * 0.5, hz = 1.34 + rnd() * 0.5;
    const t = rnd() * 4;
    if (t < 1.6) return [(t / 1.6 - 0.5) * 2 * hx, hz];
    if (t < 2.8) return [-hx, ((t - 1.6) / 1.2 - 0.5) * 2 * hz];
    return [hx, ((t - 2.8) / 1.2 - 0.5) * 2 * hz];
  };
  const spilled = (item: string, scale = 1) => { const [x, z] = spill(); place(item, x, 0.01, z, undefined, scale * (0.9 + rnd() * 0.4)); };
  // candles: rings round the front of the stone, a few melted shorter
  for (let i = 0, k = n('candle'); i < k; i++) {
    if (i >= ON_GRAVE) { spilled('candle'); continue; }
    const ring = Math.floor(i / 6), slot = i % 6, r = 0.32 + ring * 0.16;
    const ang = Math.PI * (0.12 + 0.76 * (slot + (ring % 2) * 0.5) / 6);
    place('candle', Math.cos(ang) * r * 1.6 - 0, floor, zFront + Math.sin(ang) * r * 0.9, 0, 0.75 + rnd() * 0.5);
  }
  // flowers: a bed of bunches over the grave
  for (let i = 0, k = n('flowers'); i < k; i++) {
    if (i >= ON_GRAVE) { spilled('flowers'); continue; }
    place('flowers', (rnd() - 0.5) * 1.05, floor, zFront + 0.3 + rnd() * (zEdge - zFront - 0.4), undefined, 0.85 + rnd() * 0.4);
  }
  // instant noodles: towers of cups on the sides, up to 5 high
  for (let i = 0, k = n('noodles'); i < k; i++) {
    if (i >= ON_GRAVE) { spilled('noodles'); continue; }
    const tower = Math.floor(i / 5), level = i % 5, side = tower % 2 ? 1 : -1;
    place('noodles', side * (0.6 - (rnd() * 0.04)), floor + level * 0.105, zFront + 0.35 + Math.floor(tower / 2) * 0.16, rnd() * 0.4);
  }
  // rugs: one growing heap, each rug a little twisted on top of the last
  for (let i = 0, k = n('rug'); i < k; i++) {
    if (i >= ON_GRAVE) { spilled('rug', 1.2); continue; }
    place('rug', -0.32 + (rnd() - 0.5) * 0.06, floor + i * 0.014, zEdge - 0.2 + (rnd() - 0.5) * 0.06, (rnd() - 0.5) * 1.2, 1.2);
  }
  // diamond hands: scattered, some sitting higher like they float
  for (let i = 0, k = n('diamond'); i < k; i++) {
    if (i >= ON_GRAVE) { spilled('diamond'); continue; }
    place('diamond', (rnd() - 0.5) * 1.1, floor + (rnd() < 0.3 ? 0.08 : 0), zFront + 0.25 + rnd() * (zEdge - zFront - 0.3), undefined, 0.8 + rnd() * 0.5);
  }
  // copium tanks: lined up along the front edge, then a second row
  for (let i = 0, k = n('copium'); i < k; i++) {
    if (i >= ON_GRAVE) { spilled('copium'); continue; }
    const row = Math.floor(i / 7), col = i % 7;
    place('copium', -0.6 + col * 0.2 + (row % 2) * 0.1, floor, zEdge - 0.04 - row * 0.15, rnd() * 0.6 - 0.3);
  }

  // merge everything into one mesh per material
  tmp.updateMatrixWorld(true);
  const buckets = new Map<THREE.Material, THREE.BufferGeometry[]>();
  tmp.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const geo = (o.geometry as THREE.BufferGeometry).clone().applyMatrix4(o.matrixWorld);
    o.geometry.dispose();
    const mat = o.material as THREE.Material;
    (buckets.get(mat) ?? buckets.set(mat, []).get(mat)!).push(geo);
  });
  for (const [mat, geos] of buckets) {
    const mesh = new THREE.Mesh(merge(geos), mat);
    mesh.castShadow = true;
    root.add(mesh);
    for (const gg of geos) gg.dispose();
  }
}

function offeringProp(item: string, m: ReturnType<typeof makeMaterials>): THREE.Group | null {
  const p = new THREE.Group();
  const mesh = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => { const o = new THREE.Mesh(geo, mat); o.position.set(x, y, z); p.add(o); return o; };
  switch (item) {
    case 'candle':
      mesh(new THREE.CylinderGeometry(0.03, 0.032, 0.14, 10), m.wax, 0, 0.07, 0);
      mesh(new THREE.SphereGeometry(0.022, 8, 6), m.flame, 0, 0.165, 0).scale.y = 1.7;
      break;
    case 'flowers':
      for (const [x, z, mat] of [[0, 0, m.petal], [0.05, 0.03, m.petal2], [-0.05, 0.02, m.petal2]] as const) {
        mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.14, 5), m.stem, x, 0.07, z);
        mesh(new THREE.SphereGeometry(0.03, 8, 6), mat, x, 0.15, z);
      }
      break;
    case 'noodles':
      mesh(new THREE.CylinderGeometry(0.05, 0.04, 0.11, 14), m.cup, 0, 0.055, 0);
      mesh(new THREE.CylinderGeometry(0.0505, 0.046, 0.03, 14), m.cupBand, 0, 0.06, 0);
      break;
    case 'rug':
      mesh(new THREE.BoxGeometry(0.22, 0.012, 0.15), m.rug, 0, 0.006, 0);
      mesh(new THREE.BoxGeometry(0.22, 0.014, 0.02), m.rugStripe, 0, 0.007, -0.035);
      mesh(new THREE.BoxGeometry(0.22, 0.014, 0.02), m.rugStripe, 0, 0.007, 0.035);
      break;
    case 'diamond':
      mesh(new THREE.OctahedronGeometry(0.055, 0), m.diamond, 0, 0.075, 0).scale.set(1, 1.3, 1);
      break;
    case 'copium':
      mesh(new THREE.CapsuleGeometry(0.035, 0.1, 4, 10), m.tank, 0, 0.085, 0);
      mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.04, 8), m.steel, 0, 0.18, 0);
      break;
    default:
      return null;
  }
  return p;
}
