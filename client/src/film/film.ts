import * as THREE from 'three';
import { GRAVE_LEVELS, OFFERING_ITEMS, PLOTS, levelFor, nextLevelIn, type GraveInfo, type GraveLevel, type MemeInfo, type OfferingItem } from '../../../shared/graves.ts';
import { createWorld } from '../world/world.ts';
import { getOwlTemplate } from '../owl/model.ts';
import { createOwl, type Owl } from '../owl/owl.ts';
import { GraveField } from '../world/graves.ts';
import { NameTag } from '../ui/nametag.ts';
import { GameAudio } from '../audio/audio.ts';
import { CreateGraveDialog } from '../ui/creategrave.ts';
import { Wallet } from '../wallet/wallet.ts';
import { clamp, lerp, lerpAngle, smooth } from '../util/math.ts';
import { LINES } from './script.ts';

/**
 * The REST IN PUMP trailer (open the game with ?film). About 95 seconds told with the real game scene: the same
 * world, owls, graves, gifts, dialogs and NFT art, driven by a timeline instead of players. It is staged: nothing is
 * sent to the chain, nothing is saved, and the graves and owls exist only on this screen.
 *
 * Two ways to use it:
 *   - in a browser: Play, or Record video (real time; keep the tab in front)
 *   - trailer/render.mjs: renders it frame by frame through Playwright (smooth on any machine), then mixes the
 *     narration, music and sound effects listed by cues() and encodes the MP4
 *
 *   0-10   The forgotten story     letterbox, mist, one lonely memorial
 *   10-20  One little owl          it walks up, cries, leaves the first candle
 *   20-28  The community returns   owls arrive, cry, pray, bring gifts; one starts dancing; everyone dances
 *   28.5   the bars open on the beat, the camera pulls back over the whole graveyard; logo
 *   33-44  Welcome to REST IN PUMP gather / remember / celebrate montage
 *   44-55  Create a memorial       the real "Dig a grave" dialog: search, pick, last words; the grave rises
 *   55-70  Offerings and NFTs      same camera, four grave levels; the Memorial NFT evolves
 *   70-85  More than trading       revenue -> 20% team / 80% $WTH buyback -> holders
 *   85-95  The meme lives on       the first memorial, legendary and surrounded; title card
 */

const W = 1920, H = 1080;
export const END = 95;
const DROP = 28.5;                    // the musical turning point: bars open, the music turns bouncy
const BAR = Math.round(H * 0.1);      // cinema bars, 10% of the height each
const LONELY = 13, DIG = 12, REMEMBER = 22;
const EVOLVE = [61.4, 63.6, 65.8];     // NFT evolutions: 1s of charging glow, then the flash
const PX = (plot: number) => PLOTS[plot - 1];
const front = (plot: number, dx = 0, dz = 1.85) => new THREE.Vector3(PX(plot).x + dx, 0, PX(plot).z + dz);
const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const GOLD = '#f1c76b', INK = '#ecebe6', MUTED = '#9b98a3';
const SANS = 'system-ui, "Segoe UI", Roboto, sans-serif';
const SERIF = 'Georgia, "Times New Roman", serif';

/** Same random choices on every take (so renders are repeatable). */
function rng(seed: number) { return () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646; }

// ------------------------------------------------------------------ audio cues (read by trailer/render.mjs)

export interface Sfx { at: number; kind: string; gain?: number }
/** Music: the game's own tracks, placed on the timeline (src = /audio/<src>.mp3, or a synthesized part). */
export const MUSIC = [
  { src: 'theme', at: 0, offset: 0, until: 24, gain: 0.5, fadeIn: 3, fadeOut: 4, lowpass: [900, 2600] as [number, number] },
  { src: 'synth:hope', at: 19.5, until: DROP, gain: 0.55 },
  { src: 'dance', at: DROP, offset: 8.0, until: END, gain: 0.62, fadeIn: 0.02, fadeOut: 3.5 },
  { src: 'synth:wind', at: 0, until: 24, gain: 0.35, fadeIn: 2, fadeOut: 4 },
];

const sfx: Sfx[] = [];
const cue = (at: number, kind: string, gain = 1) => { sfx.push({ at, kind, gain }); };

// ------------------------------------------------------------------ coins and graves

type Coin = MemeInfo;
const coin = (contract: string, symbol: string, name: string, icon: string | null = null): Coin => ({ chain: 'near', contract, name, symbol, decimals: 18, icon });

/** Real NEAR memes for the graves, with logos from the game's own coin search (letters if it can't answer). */
async function loadCoins(): Promise<Coin[]> {
  const wanted = ['nkok', 'neko', 'blackdragon', 'shitzu', 'lonk', 'jambo', 'gear', 'haha', 'purge', 'chill', 'intel', 'bean', 'nearvidia', 'dragon', 'slush', 'frog', 'mooncat', 'snek'];
  const out: (Coin | undefined)[] = [];
  await Promise.all(wanted.map(async (q, i) => {
    try {
      const r = await fetch(`/api/search?chain=near&q=${encodeURIComponent(q)}`).then((x) => x.json()) as { results?: { contract: string; name: string; symbol: string; icon: string | null }[] };
      const hit = r.results?.find((s) => s.icon) ?? r.results?.[0];
      if (hit) out[i] = coin(hit.contract, hit.symbol, hit.name, hit.icon);
    } catch { /* offline: letters */ }
    out[i] ??= coin(`${q}.tkn.near`, q.toUpperCase(), q);
  }));
  const seen = new Set<string>();
  return out.filter((c): c is Coin => !!c && !seen.has(c.contract) && !!seen.add(c.contract));
}

const ITEMS_BY_LEVEL: Record<GraveLevel, Partial<Record<OfferingItem, number>>> = {
  1: { candle: 2 },
  2: { candle: 6, flowers: 4, noodles: 2 },
  3: { candle: 10, flowers: 6, noodles: 5, copium: 4, rug: 2 },
  4: { candle: 14, flowers: 9, noodles: 6, copium: 6, rug: 4, diamond: 3 },
};
let graveIds = 1;
const expOf = (counts: Partial<Record<OfferingItem, number>>) => Object.entries(counts).reduce((s, [k, n]) => s + (OFFERING_ITEMS.find((i) => i.id === k)?.exp ?? 0) * (n ?? 0), 0);
function grave(plot: number, meme: Coin, counts: Partial<Record<OfferingItem, number>>, recent?: string[]): GraveInfo {
  const exp = expOf(counts);
  const offerings = Object.values(counts).reduce((s, n) => s + (n ?? 0), 0);
  return { id: graveIds++, plot, meme, message: 'Gone but not forgotten.', creator: 'whatthehoot.near', createdAt: 0, offerings, exp, level: levelFor(exp), recentItems: recent ?? Object.keys(counts).reverse().slice(0, 6), itemCounts: counts };
}

// ------------------------------------------------------------------ actors

class Actor {
  readonly owl: Owl;
  readonly pos = new THREE.Vector3();
  readonly tag: NameTag;
  yaw = 0;
  speed = 0;
  emote = 0;
  face: number | null = null;
  walkSpeed = 1.8;
  private path: THREE.Vector3[] = [];
  private phase: number;
  private hopY = 0; private hopV = 0;
  private hopEvery = 0; private nextHop = 0;

  constructor(scene: THREE.Scene, walk: number, r: () => number) {
    this.owl = createOwl();
    this.owl.setWalk(walk);
    this.phase = r() * 10;
    this.tag = new NameTag('');
    scene.add(this.owl.root, this.owl.blob, this.tag.sprite);
    this.show(false);
  }

  /** The name tag shows itself only while it has a bubble (say), so a shown owl never brings back an old one. */
  show(on: boolean) { this.owl.root.visible = this.owl.blob.visible = on; if (!on) { this.tag.clearBubble(); this.tag.sprite.visible = false; } }
  get shown() { return this.owl.root.visible; }
  /** Puts it somewhere at once (a cut), standing still. */
  place(at: THREE.Vector3, yaw: number, emote = 0) {
    this.pos.copy(at); this.yaw = yaw; this.face = yaw; this.emote = emote; this.path = []; this.speed = 0; this.hopEvery = 0; this.tag.clearBubble(); this.show(true);
  }
  walk(points: THREE.Vector3[], face: number | null = null, speed = 1.8) { this.path = points.map((p) => p.clone()); this.face = face; this.walkSpeed = speed; this.emote = 0; }
  hop() { if (this.hopY === 0) this.hopV = 4.2; }
  hopping(every: number, t: number) { this.hopEvery = every; this.nextHop = t + every * 0.5; }

  update(dt: number, t: number) {
    const goal = this.path[0];
    if (goal) {
      const dx = goal.x - this.pos.x, dz = goal.z - this.pos.z, d = Math.hypot(dx, dz);
      if (d < 0.08) this.path.shift();
      else {
        this.yaw = lerpAngle(this.yaw, Math.atan2(dx, dz), 1 - Math.exp(-9 * dt));
        this.speed = lerp(this.speed, this.walkSpeed, 1 - Math.exp(-6 * dt));
        const step = Math.min(d, this.speed * dt);
        this.pos.x += (dx / d) * step; this.pos.z += (dz / d) * step;
      }
    }
    if (!this.path.length) {
      this.speed = lerp(this.speed, 0, 1 - Math.exp(-9 * dt));
      if (this.face !== null) this.yaw = lerpAngle(this.yaw, this.face, 1 - Math.exp(-6 * dt));
    }
    if (this.hopEvery && t >= this.nextHop) { this.hop(); this.nextHop = t + this.hopEvery; }
    if (this.hopY > 0 || this.hopV > 0) {
      this.hopV -= 12.5 * dt; this.hopY = Math.max(0, this.hopY + this.hopV * dt);
      if (this.hopY === 0) this.hopV = 0;
    }
    this.phase += this.speed * dt * 8;
    this.owl.root.position.set(this.pos.x, this.hopY, this.pos.z);
    this.owl.root.rotation.y = this.yaw;
    this.owl.animate(dt, t, { emote: this.speed < 0.2 ? this.emote : 0, speed: this.speed, phase: this.phase, air: this.hopY > 0, vy: this.hopV, land: 0 });
    this.tag.sprite.position.set(this.pos.x, this.hopY + 1.0, this.pos.z);
    this.tag.tick(performance.now());
  }
}

// ------------------------------------------------------------------ particles (dirt when a grave is dug, sparkles on gifts and level ups)

class Bursts {
  private readonly items: { mesh: THREE.Mesh; vel: THREE.Vector3; life: number; max: number; dirt: boolean }[] = [];
  private readonly scene: THREE.Scene;
  private readonly dirt = new THREE.MeshStandardMaterial({ color: 0x5a3f2a, roughness: 1 });
  private readonly spark = new THREE.MeshBasicMaterial({ color: 0xffd36b, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  private readonly geo = new THREE.IcosahedronGeometry(0.06, 0);
  private readonly r: () => number;
  constructor(scene: THREE.Scene, r: () => number) { this.scene = scene; this.r = r; }

  burst(at: THREE.Vector3, kind: 'dirt' | 'spark', n: number) {
    const r = this.r;
    for (let i = 0; i < n; i++) {
      const dirt = kind === 'dirt';
      const m = new THREE.Mesh(this.geo, dirt ? this.dirt : this.spark.clone());
      const a = r() * Math.PI * 2, s = dirt ? 1.2 + r() * 2 : 0.6 + r() * 1.6;
      m.position.copy(at).add(v((r() - 0.5) * 0.8, dirt ? 0.1 : 0.4 + r() * 1.2, (r() - 0.5) * 0.8));
      m.scale.setScalar(dirt ? 0.5 + r() * 0.7 : 0.5 + r());
      this.scene.add(m);
      const max = dirt ? 1.1 : 1.6;
      this.items.push({ mesh: m, vel: v(Math.cos(a) * s * 0.6, dirt ? 2.5 + r() * 2.5 : 0.8 + r() * 1.8, Math.sin(a) * s * 0.6), life: max, max, dirt });
    }
  }

  update(dt: number) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const p = this.items[i];
      p.life -= dt;
      p.vel.y -= (p.dirt ? 9 : 0.6) * dt;
      p.mesh.position.addScaledVector(p.vel, dt);
      if (p.mesh.position.y < 0.03) { p.mesh.position.y = 0.03; p.vel.set(0, 0, 0); }
      if (!p.dirt) (p.mesh.material as THREE.MeshBasicMaterial).opacity = clamp(p.life / p.max, 0, 1);
      else if (p.life < 0.3) p.mesh.scale.multiplyScalar(0.9);
      if (p.life <= 0) { this.scene.remove(p.mesh); if (!p.dirt) (p.mesh.material as THREE.Material).dispose(); this.items.splice(i, 1); }
    }
  }

  clear() { for (const p of this.items) this.scene.remove(p.mesh); this.items.length = 0; }
}

// ------------------------------------------------------------------ ground mist (thick at the start, thin later)

class Mist {
  private readonly items: { s: THREE.Sprite; base: number; vx: number; x0: number; x1: number }[] = [];
  constructor(scene: THREE.Scene, r: () => number) {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d')!;
    const grad = g.createRadialGradient(64, 64, 4, 64, 64, 62);
    grad.addColorStop(0, 'rgba(255,255,255,0.85)'); grad.addColorStop(0.5, 'rgba(255,255,255,0.35)'); grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
    const tex = new THREE.CanvasTexture(c);
    const L = PLOTS[12];
    for (let i = 0; i < 70; i++) {
      const m = new THREE.SpriteMaterial({ map: tex, color: 0x9298bb, transparent: true, depthWrite: false, opacity: 0 });
      const sp = new THREE.Sprite(m);
      const nearGrave = i < 40;
      const x = nearGrave ? L.x - 5 + r() * 10 : -3 + r() * 6, z = nearGrave ? L.z - 5 + r() * 12 : -8 + r() * 24;
      sp.position.set(x, 0.3 + r() * 0.7, z);
      const w = 3 + r() * 4; sp.scale.set(w, w * (0.35 + r() * 0.2), 1);
      sp.renderOrder = 1;
      scene.add(sp);
      this.items.push({ s: sp, base: 0.05 + r() * 0.08, vx: (r() - 0.5) * 0.25, x0: x - 3, x1: x + 3 });
    }
  }
  update(dt: number, k: number) {
    for (const m of this.items) {
      m.s.position.x += m.vx * dt;
      if (m.s.position.x > m.x1 || m.s.position.x < m.x0) m.vx = -m.vx;
      (m.s.material as THREE.SpriteMaterial).opacity = m.base * k;
      m.s.visible = k > 0.01;
    }
  }
}

// ------------------------------------------------------------------ the trailer

export async function runFilm(): Promise<void> {
  const capture = new URLSearchParams(location.search).has('capture');
  const showCaptions = !new URLSearchParams(location.search).has('nocc');
  document.body.classList.add('film');
  if (capture) document.body.classList.add('film-capture');
  const out = document.createElement('canvas');
  out.width = W; out.height = H; out.id = 'film-out';
  document.body.append(out);
  const ctx = out.getContext('2d')!;
  const ui = document.createElement('div');
  ui.id = 'film-ui';
  ui.innerHTML = `<div class="film-card"><h1>REST IN PUMP: the trailer</h1><p>A staged story made from the real game scene. Graves and owls here exist only on this screen.</p>
    <div class="film-btns"><button id="film-play" class="btn btn-quiet" type="button">Play</button><button id="film-rec" class="btn btn-go" type="button">Record video</button></div>
    <p id="film-msg" class="film-msg">Loading the graveyard…</p></div>`;
  document.body.append(ui);
  if (capture) ui.hidden = true;
  const msg = ui.querySelector('#film-msg') as HTMLElement;

  // film time drives everything that reads the clock (speech bubbles), so frame-by-frame renders keep real timing
  let clock = 0;
  const realNow = performance.now.bind(performance);
  const t0 = realNow();
  performance.now = () => (capture ? t0 + clock * 1000 : realNow());

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(1); renderer.setSize(W, H, false);
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.15;
  const world = createWorld(renderer);
  world.setShadows(true);
  getOwlTemplate();
  const camera = new THREE.PerspectiveCamera(40, W / H, 0.05, 600);
  const field = new GraveField(world.scene, world.colliders, world.materials.stone, world.materials.iron);
  let r = rng(11);
  const bursts = new Bursts(world.scene, () => r());
  const flash = new THREE.PointLight(0xffd36b, 0, 9, 1.6);
  const candleGlow = new THREE.PointLight(0xffa04a, 0, 6, 1.8);
  candleGlow.position.set(PX(LONELY).x, 0.7, PX(LONELY).z - 0.2);
  world.scene.add(flash, candleGlow);
  const fog = world.scene.fog as THREE.FogExp2;
  const mist = new Mist(world.scene, rng(5));
  const audio = new GameAudio();
  const dialog = new CreateGraveDialog(new Wallet(), () => {});
  const dlgEl = document.getElementById('grave-dlg') as HTMLDialogElement;

  const img = (src: string) => new Promise<HTMLImageElement | null>((res) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = src; });
  const [coins, logo, ...nfts] = await Promise.all([loadCoins(), img('/logo-256.png'), img('/docs/level-1.svg'), img('/docs/level-2.svg'), img('/docs/level-3.svg'), img('/docs/level-4.svg')]);
  // the forgotten memorial is $LONK, with its own logo
  const lonelyCoin = coin('token.lonkingnearbackto2024.near', 'LONK', 'LONK', '/film/lonk.png');
  const digCoin = coins[1] ?? coins[0], rest = coins.slice(2).filter((c) => !/lonk/i.test(c.symbol));
  const pickCoin = (i: number) => rest[i % Math.max(1, rest.length)] ?? lonelyCoin;

  // ---- cast: the WTH owl and a crowd, created once (shared materials), placed per take
  const hero = new Actor(world.scene, 4, () => r());
  const crowd: Actor[] = [];
  for (let i = 0; i < 28; i++) crowd.push(new Actor(world.scene, [0, 1, 2, 3, 5, 6, 7, 8][i % 8], () => r()));
  const all = [hero, ...crowd];

  // ---- state of one take
  let lonelyCounts: Partial<Record<OfferingItem, number>> = {};
  let lonelyRecent: string[] = [];
  let lonely: GraveInfo | null = null;
  let pop: { plot: number; at: number } | null = null;
  let focusPlot: number | null = null;
  let popups: { text: string; at: THREE.Vector3; t: number }[] = [];
  let levelBanner: { level: GraveLevel; t: number } | null = null;
  let events: { at: number; fn: () => boolean | void; done: boolean }[] = [];

  const giftAt = (plot: number) => v(PX(plot).x, 0, PX(plot).z - 0.2);
  function setLonely(counts: Partial<Record<OfferingItem, number>>, sound: 'gift' | 'none' = 'gift', item?: OfferingItem) {
    const before = lonely?.level ?? 1;
    lonelyCounts = { ...counts };
    if (item) lonelyRecent = [item, ...lonelyRecent.filter((x) => x !== item)].slice(0, 6);
    lonely = grave(LONELY, lonelyCoin, lonelyCounts, lonelyRecent.length ? lonelyRecent : undefined);
    field.addGrave(lonely);
    if (sound === 'none') return;
    const at = giftAt(LONELY);
    if (lonely.level > before) {
      bursts.burst(at, 'spark', 70); pop = { plot: LONELY, at: clock }; levelBanner = { level: lonely.level, t: clock };
      flash.position.set(at.x, 1.8, at.z + 0.8); flash.intensity = 34;
    } else bursts.burst(at.clone().setZ(at.z + 1.0), 'spark', 16);
  }
  /** A gift at the lonely grave: the giver kneels (pray) and hops, +EXP floats up, the grave may level up. */
  const gift = (at: number, item: OfferingItem, giver: Actor | null, n = 1) => {
    const exp = (OFFERING_ITEMS.find((i) => i.id === item)?.exp ?? 0) * n;
    events.push({ at, done: false, fn: () => {
      if (giver) { giver.emote = 3; giver.hop(); }
      setLonely({ ...lonelyCounts, [item]: (lonelyCounts[item] ?? 0) + n }, 'gift', item);
      popups.push({ text: `+${exp} EXP`, at: giftAt(LONELY).add(v(0, 1.2, 0.9)), t: clock });
    } });
    // sound is planned up front so the audio render knows it (level ups get the fanfare)
    const counts = { ...plannedCounts, [item]: (plannedCounts[item] ?? 0) + n };
    plannedCounts = counts;
    cue(at, levelFor(expOf(counts)) > plannedLevel ? 'levelup' : 'gift');
    plannedLevel = Math.max(plannedLevel, levelFor(expOf(counts)));
  };
  let plannedCounts: Partial<Record<OfferingItem, number>> = {};
  let plannedLevel = 1;
  const ev = (at: number, fn: () => boolean | void) => events.push({ at, fn, done: false });

  // ---- the graveyard after the reveal: other memorials at all levels
  const others = () => {
    const plots = [1, 3, 6, 8, 10, 15, 17, 19, REMEMBER, 24, 27, 30, 33, 35, 38, 40];
    const levels: GraveLevel[] = [2, 1, 3, 1, 2, 4, 1, 2, 3, 1, 2, 1, 3, 2, 1, 2];
    return plots.map((p, i) => grave(p, pickCoin(i + 3), ITEMS_BY_LEVEL[levels[i]]));
  };

  function setup() {
    r = rng(11);
    sfx.length = 0; events = []; popups = []; levelBanner = null; plannedCounts = {}; plannedLevel = 1;
    for (const a of all) { a.show(false); a.emote = 0; }
    bursts.clear(); graveIds = 1; pop = null; focusPlot = null; flash.intensity = 0; candleGlow.intensity = 0;
    lonelyCounts = {}; lonelyRecent = [];
    lonely = null;
    if (dlgEl.open) dlgEl.close();
    field.setGraves([]);
    setLonely({}, 'none');
    const L = PX(LONELY);
    const [a, b, c, d, e, f, g, h] = crowd;

    // 1. the forgotten story
    cue(0.0, 'wind-in'); cue(3.4, 'crow', 0.8); cue(8.4, 'crow', 0.5);

    // 2. one little owl (zombie shuffle, quiet), notices the grave, cries, leaves the first candle
    ev(10.1, () => { hero.place(v(L.x - 2.9, 0, L.z + 1.9), Math.PI / 2); hero.walk([front(LONELY)], Math.PI, 1.25); });
    for (let s = 10.4; s < 12.6; s += 0.42) cue(s, 'step', 0.5);
    cue(12.7, 'notice', 0.7);
    ev(13.3, () => { hero.emote = 4; }); cue(13.3, 'cry', 0.55);
    ev(16.2, () => { hero.emote = 3; });
    ev(16.9, () => { setLonely({ candle: 1 }, 'gift', 'candle'); }); cue(16.9, 'candle');
    ev(17.6, () => { hero.emote = 4; });

    // 3. the community returns
    const row1 = [front(LONELY, 1.15, 1.95), front(LONELY, -1.15, 1.95)];
    const row2 = [front(LONELY, 0.55, 2.95), front(LONELY, -0.6, 3.0), front(LONELY, 1.75, 2.85), front(LONELY, -1.8, 2.9)];
    ev(20.2, () => { a.place(v(L.x + 3.2, 0, L.z + 2.6), -Math.PI / 2); a.walk([row1[0]], Math.PI, 1.6); }); cue(20.5, 'pop', 0.4);
    ev(21.2, () => { b.place(v(L.x - 3.6, 0, L.z + 3.2), Math.PI / 2); b.walk([row1[1]], Math.PI, 3.2); }); cue(21.4, 'pop', 0.4);
    ev(22.2, () => { a.emote = 4; });
    ev(22.6, () => { c.place(v(L.x + 0.6, 0, L.z + 7.5), Math.PI); c.walk([row2[0]], Math.PI, 2.2); }); cue(22.8, 'pop', 0.4);
    ev(22.9, () => { d.place(v(L.x - 1.2, 0, L.z + 7.8), Math.PI); d.walk([row2[1]], Math.PI, 2.4); });
    ev(23.0, () => { b.emote = 4; });
    ev(23.3, () => { e.place(v(L.x + 4.5, 0, L.z + 4.8), -Math.PI / 2); e.walk([row2[2]], Math.PI, 2.6); f.place(v(L.x - 4.6, 0, L.z + 5.2), Math.PI / 2); f.walk([row2[3]], Math.PI, 2.6); }); cue(23.5, 'pop', 0.4);
    ev(24.4, () => { c.emote = 3; d.emote = 4; });
    gift(24.6, 'flowers', e);
    gift(25.3, 'noodles', f);
    ev(25.6, () => { g.place(v(L.x + 2.6, 0, L.z + 5.6), Math.PI); g.walk([front(LONELY, 0.1, 3.9)], Math.PI, 2.4); });
    gift(26.0, 'copium', c); cue(26.05, 'boing', 0.7);
    ev(26.4, () => { e.emote = 4; f.emote = 4; c.emote = 4; });
    ev(26.6, () => { g.emote = 1; }); cue(26.6, 'scratch', 0.8);     // one owl starts dancing while everyone cries
    ev(27.5, () => { h.place(v(L.x - 2.4, 0, L.z + 4.4), 0.4, 1); a.emote = 1; });
    // after "What if those memories could bring everyone together again?": more and more owls
    const more = crowd.slice(8, 20);
    const spots3 = [[-2.6, 4.0], [-1.3, 4.3], [1.4, 4.2], [2.7, 4.0], [-2.1, 5.1], [-0.7, 5.3], [0.8, 5.3], [2.2, 5.1], [-3.4, 3.1], [3.3, 3.2], [-1.5, 6.2], [1.6, 6.2]];
    more.forEach((x, i) => {
      const at = 24.9 + i * 0.2, [dx, dz] = spots3[i], side = dx < 0 ? -1 : 1;
      ev(at, () => { x.place(v(L.x + dx + side * 4, 0, L.z + dz + 4), side < 0 ? Math.PI / 2 : -Math.PI / 2); x.walk([front(LONELY, dx, dz)], Math.PI, 2.6 + (i % 3) * 0.4); });
      ev(at + 1.8, () => { x.emote = [4, 3, 4, 4, 3, 4][i % 6]; });
      if (i % 3 === 0) cue(at + 0.2, 'pop', 0.3);
    });
    ev(28.0, () => { for (const x of [b, c, d, e, f, h, ...more]) x.emote = 1; hero.emote = 1; });
    ev(28.3, () => { field.setGraves([lonely!, ...others()]); });       // the rest of the graveyard, just off screen
    cue(DROP - 0.6, 'whoosh'); cue(DROP, 'impact'); cue(DROP + 0.8, 'shimmer', 0.6);
    ev(DROP, () => { for (const x of [a, c, e, g, ...more.filter((_, i) => i % 3 === 0)]) x.hopping(1.1, clock); });

    function ring(list: Actor[], r1: number, r2: number) {
      list.forEach((x, i) => {
        const ang = (i / list.length) * Math.PI * 2 + r1, rr2 = i % 2 ? r2 : r1;
        x.place(v(Math.sin(ang) * rr2, 0, 7 + Math.cos(ang) * rr2), ang + Math.PI, [1, 2, 1, 5, 1, 2, 1, 1, 2, 1][i % 10]);
        if (i % 3 === 0) x.hopping(0.8 + (i % 2) * 0.3, clock);
      });
    }
    // 4. welcome to REST IN PUMP: gather / remember / celebrate / wide
    ev(33.0, () => {
      for (const x of all) x.show(false);
      a.place(v(-0.9, 0, 14.5), Math.PI); b.place(v(0, 0, 15.2), Math.PI); c.place(v(0.95, 0, 14.7), Math.PI);
      a.owl.setWalk(0); b.owl.setWalk(3); c.owl.setWalk(5);
      a.walk([v(-0.9, 0, 3)], Math.PI, 1.7); b.walk([v(0, 0, 3.5)], Math.PI, 1.7); c.walk([v(0.95, 0, 3)], Math.PI, 1.7);
    });
    // gather: a second and a third wave come through the gate behind them
    [[34.0, 3, 7], [34.9, 7, 12]].forEach(([at, i0, i1]) => ev(at, () => {
      crowd.slice(i0, i1).forEach((x, k, arr) => {
        const xx = -1.7 + (k / Math.max(1, arr.length - 1)) * 3.4;
        x.place(v(xx, 0, 17.2 + (k % 2) * 0.7), Math.PI); x.walk([v(xx, 0, 3)], Math.PI, 1.8 + (k % 3) * 0.2);
      });
    }));
    ev(34.4, () => b.tag.say('gm graveyard'));
    cue(33.0, 'title'); cue(36.0, 'title'); cue(38.8, 'title');
    // remember: a few mourners, then rows of them
    const mourn = [[-0.9, 1.9], [0.9, 1.9], [-0.2, 2.8], [1.5, 2.9], [-1.6, 2.8], [-2.3, 3.7], [-1.0, 3.8], [0.4, 3.8], [1.8, 3.8], [-1.7, 4.7], [-0.3, 4.8], [1.1, 4.8], [2.5, 4.6], [-2.9, 2.6]];
    const R0 = PX(REMEMBER);
    ev(36.0, () => {
      for (const x of all) x.show(false);
      crowd.slice(0, 5).forEach((x, i) => x.place(v(R0.x + mourn[i][0], 0, R0.z + mourn[i][1]), Math.PI + (i === 3 ? 0.3 : 0), [4, 3, 4, 0, 4][i]));
    });
    ev(37.0, () => crowd.slice(5, 14).forEach((x, i) => x.place(v(R0.x + mourn[i + 5][0], 0, R0.z + mourn[i + 5][1]), Math.PI, [3, 4, 4, 3, 4, 4, 3, 4, 4][i])));
    ev(36.5, () => crowd[3].tag.say('rest easy, king'));
    ev(37.6, () => crowd[2].tag.say('i was early...'));
    ev(38.8, () => {
      for (const x of all) x.show(false);
      ring(crowd.slice(0, 10), 1.4, 2.0);
    });
    // celebrate: a second ring joins, then a third
    ev(39.8, () => ring(crowd.slice(10, 20), 2.8, 3.4));
    ev(40.8, () => ring(crowd.slice(20, 28), 4.2, 4.6));
    ev(40.0, () => crowd[4].tag.say('wen pump? oh. wait.'));
    ev(41.8, () => {
      for (const x of all) x.show(false);
      crowd.forEach((x, i) => {
        if (i < 16) { const p = PLOTS[[0, 2, 5, 9, 14, 16, 18, 21, 23, 26, 29, 32, 34, 37, 39, 7][i]]; x.place(v(p.x + 0.4, 0, p.z + 1.9), Math.PI, [4, 1, 3, 2, 1, 4, 5, 1, 3, 1, 2, 4, 1, 2, 1, 3][i]); }
        else { const k = i - 16; x.place(v(-1.2 + (k % 3) * 1.2, 0, -6 + Math.floor(k / 3) * 3.2), Math.PI, 0); x.walk([v(-1.2 + (k % 3) * 1.2, 0, 14)], 0, 1.7); }
      });
      hero.place(v(-0.5, 0, 9), Math.PI); hero.walk([v(-0.3, 0, -2)], Math.PI, 1.8);
    });

    // 5. create a memorial: the real dialog, with a search, a pick and last words (staged: no payment is sent)
    ev(44.0, () => {
      for (const x of all) x.show(false);
      hero.place(v(-1.2, 0, 1.4), -Math.PI / 2 - 0.5); hero.walk([v(-3.2, 0, -0.6), front(DIG, 0, 1.2)], Math.PI, 1.9);
    });
    ev(44.9, () => { focusPlot = DIG; });
    ev(45.6, () => { void dialog.open(DIG); }); cue(45.6, 'click');
    const typeInto = (sel: string, text: string, start: number, every: number) => {
      [...text].forEach((_, i) => {
        ev(start + i * every, () => {
          const el = document.querySelector(sel) as HTMLInputElement | HTMLTextAreaElement | null;
          if (!el) return false;
          el.focus(); el.value = text.slice(0, i + 1); el.dispatchEvent(new Event('input', { bubbles: true }));
        });
        cue(start + i * every, 'key', 0.35);
      });
    };
    typeInto('#grave-contract', 'neko', 46.2, 0.22);
    ev(48.0, () => {
      const items = [...document.querySelectorAll<HTMLLIElement>('#grave-sugg li')];
      if (!items.length) return false;                       // waits for the real search
      (items.find((li) => li.textContent?.includes(digCoin.contract)) ?? items[0]).click();
    }); cue(48.0, 'click');
    typeInto('#grave-msg', 'Bought the top. Held with honor.', 49.0, 0.055);
    ev(48.9, () => !!document.querySelector('#grave-msg'));   // waits for the coin lookup
    ev(51.4, () => { (document.querySelector('#grave-body .gm-foot .btn-go') as HTMLButtonElement | null)?.click(); }); cue(51.4, 'click');
    ev(52.5, () => { dlgEl.close(); focusPlot = null; });
    ev(52.7, () => {
      field.addGrave(grave(DIG, digCoin, {}));
      bursts.burst(v(PX(DIG).x, 0, PX(DIG).z - 0.6), 'dirt', 28); pop = { plot: DIG, at: clock }; hero.hop();
    }); cue(52.7, 'bell'); cue(52.7, 'thud');
    ev(53.6, () => hero.tag.say('rest in pump'));

    // 6. offerings, grave levels and the Memorial NFT (same camera for all four levels)
    ev(55.5, () => {
      for (const x of all) x.show(false);
      setLonely({ candle: 1, flowers: 1, noodles: 1, copium: 1 }, 'none');   // where scene 3 left it (20 EXP)
      hero.place(front(LONELY, 0, 1.9), Math.PI, 0);
      a.place(front(LONELY, 1.25, 2.05), Math.PI - 0.15); b.place(front(LONELY, -1.25, 2.05), Math.PI + 0.15);
      c.place(front(LONELY, 0.7, 3.05), Math.PI); d.place(front(LONELY, -0.75, 3.05), Math.PI);
    });
    plannedCounts = { candle: 1, flowers: 1, noodles: 1, copium: 1 }; plannedLevel = 1;
    gift(55.9, 'candle', a); gift(56.25, 'flowers', b); gift(56.6, 'noodles', c);                         // -> Remembered
    gift(57.0, 'copium', d); gift(57.35, 'rug', a); gift(57.7, 'rug', b); gift(58.1, 'diamond', hero);      // -> Honored
    gift(58.5, 'diamond', c); gift(58.85, 'rug', d, 3); gift(59.4, 'diamond', a, 14);                    // -> Legendary
    ev(59.8, () => { for (const x of [a, b, c, d]) x.emote = 1; hero.emote = 1; hero.hopping(1.0, clock); });
    cue(60.5, 'whoosh', 0.6);
    for (const k of EVOLVE) { cue(k, 'evolve'); cue(k + 1.0, 'levelup'); }
    cue(67.4, 'shimmer');

    // 7. more than trading
    ev(70.0, () => {
      for (const x of all) x.show(false);
      hero.place(front(LONELY, 0.3, 2.6), Math.PI); hero.walk([front(LONELY, 0.1, 1.85)], Math.PI, 1.4);
      a.place(front(LONELY, 1.4, 2.4), Math.PI - 0.3, 3); b.place(front(LONELY, -1.4, 2.4), Math.PI + 0.3, 4);
    });
    gift(71.4, 'diamond', hero);
    cue(73.4, 'node'); cue(74.6, 'node'); cue(75.8, 'coins'); cue(77.4, 'node'); cue(79.8, 'title', 0.6);

    // 8. the meme lives on: the first memorial, legendary, surrounded; the WTH owl is still crying
    ev(84.8, () => {
      for (const x of all) x.show(false);
      hero.place(front(LONELY, 0, 1.8), Math.PI, 4);
      crowd.forEach((x, i) => {
        const ang = -1.1 + (i / (crowd.length - 1)) * 2.2, rad = 2.4 + (i % 3) * 0.9;
        x.place(v(L.x + Math.sin(ang) * rad, 0, L.z + 1.8 + Math.cos(ang) * rad * 0.8), Math.PI + ang * 0.4, [1, 2, 1, 1, 5, 2, 1, 1, 2, 1, 1, 3, 1, 2, 1, 1][i]);
        if (i % 4 === 1) x.hopping(0.9, clock);
      });
    });
    ev(86.0, () => crowd[6].tag.say('LEGENDARY'));
    ev(87.6, () => crowd[11].tag.say('we never left'));
    cue(90.2, 'impact', 0.7); cue(90.2, 'bell', 0.6);
    events.sort((x, y) => x.at - y.at);
    sfx.sort((x, y) => x.at - y.at);
  }

  // ---- camera, shot by shot
  const camPos = v(0, 0, 0), camLook = v(0, 0, 0);
  const smPos = v(0, 0, 0), smLook = v(0, 0, 0);
  const L = PX(LONELY), D = PX(DIG), R = PX(REMEMBER);
  const between = (t: number, t0: number, t1: number, p0: THREE.Vector3, l0: THREE.Vector3, p1: THREE.Vector3, l1: THREE.Vector3) => {
    const u = smooth(t0, t1, t);
    camPos.lerpVectors(p0, p1, u); camLook.lerpVectors(l0, l1, u);
  };
  const orbit = (c: THREE.Vector3, a: number, rad: number, h: number, lookY = c.y) => { camPos.set(c.x + Math.sin(a) * rad, c.y + h, c.z + Math.cos(a) * rad); camLook.set(c.x, lookY, c.z); };
  /** Sets camPos/camLook for time t. Returns true on a hard cut (no smoothing into this frame). */
  function shot(t: number): boolean {
    // 1: glide down the path, turn to the lonely grave, push in
    if (t < 10) {
      if (t < 5.5) between(t, 0, 5.5, v(-1.6, 2.6, 5.8), v(2.4, 0.8, -1), v(1.0, 1.8, 1.6), v(3.6, 0.7, -3));
      else between(t, 5.5, 10, v(1.0, 1.8, 1.6), v(3.6, 0.7, -3), v(L.x, 0.95, L.z + 2.1), v(L.x, 0.68, L.z - 0.75));
      return t < 0.05;
    }
    // 2: the owl walks in (wide), then a close 3/4 from beside the grave while it cries
    if (t < 13.6) { between(t, 10, 13.6, v(L.x + 2.6, 1.35, L.z + 4.6), v(L.x, 0.55, L.z + 0.6), v(L.x + 2.2, 1.25, L.z + 4.1), v(L.x - 0.1, 0.6, L.z + 1.0)); return t < 10.05; }
    if (t < 20) { between(t, 13.6, 20, v(L.x + 2.0, 1.15, L.z - 0.6), v(L.x, 0.62, L.z + 1.05), v(L.x + 1.6, 1.05, L.z - 0.3), v(L.x, 0.64, L.z + 1.1)); return t < 13.65; }
    // 3: the community arrives (front 3/4), gifts close up, the first dancer, everyone dances
    if (t < 24.4) { between(t, 20, 24.4, v(L.x + 3.3, 1.55, L.z + 0.1), v(L.x - 0.4, 0.6, L.z + 2.9), v(L.x + 2.9, 1.45, L.z + 0.4), v(L.x - 0.3, 0.6, L.z + 2.9)); return t < 20.05; }
    if (t < 26.5) { between(t, 24.4, 26.5, v(L.x + 1.5, 1.25, L.z + 3.3), v(L.x, 0.35, L.z - 0.1), v(L.x + 1.2, 1.15, L.z + 3.0), v(L.x, 0.35, L.z - 0.1)); return t < 24.45; }
    if (t < DROP) { between(t, 26.5, DROP, v(L.x - 2.6, 1.25, L.z + 0.2), v(L.x + 0.4, 0.62, L.z + 3.3), v(L.x - 2.3, 1.2, L.z + 0.5), v(L.x + 0.3, 0.62, L.z + 3.2)); return t < 26.55; }
    // the reveal: crane up and back over the whole graveyard (logo on top)
    if (t < 33) { between(t, DROP, 33, v(L.x - 2.3, 1.2, L.z + 0.5), v(L.x + 0.3, 0.62, L.z + 3.2), v(-3, 11.5, 22), v(0.5, 0, -1)); return false; }
    // 4: gather (tracking backwards in front of three owls walking down the path)
    if (t < 36) { const z = lerp(14.5, 3, (t - 33) / ((14.5 - 3) / 1.7)); camPos.set(0.6, 1.25, z - 3.4); camLook.set(0, 0.75, z + 0.2); return t < 33.05; }
    if (t < 38.8) { orbit(v(R.x, 0.6, R.z + 2.2), 1.85 - (t - 36) * 0.1, 3.8, 0.9, 0.7); return t < 36.05; }
    if (t < 41.8) { orbit(v(0, 0.55, 7), 0.2 + (t - 38.8) * 0.22, 5.2, 0.55, 0.8); return t < 38.85; }
    if (t < 44) { between(t, 41.8, 44, v(-14, 8, 13), v(-1, 0, -2), v(-9, 9, 15), v(1, 0, -2)); return t < 41.85; }
    // 5: third-person follow behind the owl, then the dialog, then the new grave
    if (t < 52.5) {
      const back = 3.4, yaw = hero.yaw;
      camPos.set(hero.pos.x - Math.sin(yaw) * back, 1.65, hero.pos.z - Math.cos(yaw) * back); camLook.set(hero.pos.x, 0.65, hero.pos.z);
      if (t > 45.6) { camPos.set(D.x + 1.2, 2.6, D.z + 5.4); camLook.set(D.x, 0.4, D.z); }
      return t < 44.05 || (t > 45.6 && t < 45.65);
    }
    if (t < 55.5) { between(t, 52.5, 55.5, v(D.x + 2.7, 1.75, D.z - 3.5), v(D.x - 0.3, 0.55, D.z + 0.8), v(D.x + 2.4, 1.6, D.z - 3.1), v(D.x - 0.3, 0.6, D.z + 0.8)); return t < 52.55; }
    // 6: one fixed frame for the four levels, then a slow move for the NFT card
    if (t < 60.5) { camPos.set(L.x + 3.1, 2.1, L.z + 6.3); camLook.set(L.x - 0.2, 0.95, L.z - 0.2); return t < 55.55; }
    if (t < 70) { between(t, 60.5, 70, v(L.x + 3.1, 2.1, L.z + 6.3), v(L.x - 0.2, 0.95, L.z - 0.2), v(L.x + 4.2, 2.3, L.z + 5.6), v(L.x - 1.4, 1.1, L.z - 0.4)); return false; }
    // 7: the diamond hands close up, then a slow orbit behind the flow
    if (t < 72.6) { between(t, 70, 72.6, v(L.x + 1.6, 1.3, L.z + 4.2), v(L.x, 0.5, L.z + 0.9), v(L.x + 1.3, 1.15, L.z + 3.7), v(L.x, 0.55, L.z + 0.9)); return t < 70.05; }
    if (t < 84.8) { orbit(v(L.x, 1.0, L.z), 0.6 - (t - 72.6) * 0.045, 8.5, 3.2, 0.8); return t < 72.65; }
    // 8: wide, warm, full circle
    between(t, 84.8, END, v(L.x + 6.8, 1.9, L.z + 8.6), v(L.x, 0.9, L.z + 1.0), v(L.x + 5.0, 4.4, L.z + 11.5), v(L.x, 0.6, L.z + 1.2));
    return t < 84.85;
  }

  // ---- the look: fog, exposure, colour grade
  function look(t: number) {
    fog.density = t < 10 ? 0.058 : t < 30 ? lerp(0.058, 0.024, smooth(10, 30, t)) : 0.024;
    mist.update(1 / 30, t < 18 ? 1 : t < 30 ? lerp(1, 0.25, smooth(18, 30, t)) : t > 84.8 ? 0.35 : 0.2);
    renderer.toneMappingExposure = lerp(0.98, 1.15, smooth(14, 30, t));
    candleGlow.intensity = t < 16.9 ? 0 : t < 55 ? 3 * smooth(16.9, 18, t) : 4;
  }

  // ---- overlay drawing
  function text(s: string, x: number, y: number, size: number, color: string, alpha: number, o: { weight?: number; family?: string; spacing?: number; align?: CanvasTextAlign; italic?: boolean; stroke?: boolean } = {}) {
    if (alpha <= 0.002) return;
    ctx.save();
    ctx.globalAlpha = clamp(alpha, 0, 1);
    ctx.font = `${o.italic ? 'italic ' : ''}${o.weight ?? 800} ${size}px ${o.family ?? SANS}`;
    (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${o.spacing ?? 0}px`;
    ctx.textAlign = o.align ?? 'center'; ctx.textBaseline = 'middle';
    if (o.stroke !== false) { ctx.lineWidth = Math.max(3, size * 0.12); ctx.strokeStyle = 'rgba(8,6,12,.82)'; ctx.lineJoin = 'round'; ctx.strokeText(s, x, y); }
    ctx.fillStyle = color; ctx.fillText(s, x, y);
    ctx.restore();
  }
  const win = (t: number, a: number, b: number, f = 0.35) => clamp(Math.min((t - a) / f, (b - t) / f), 0, 1);
  const easeOut = (u: number) => 1 - Math.pow(1 - clamp(u, 0, 1), 3);

  /** A short title that lands with a small rise and settles its letter spacing. */
  function title(s: string, t: number, a: number, b: number, y: number, size = 92, color = INK) {
    const k = win(t, a, b, 0.3), u = easeOut((t - a) / 0.5);
    text(s, W / 2, y + (1 - u) * 18, size, color, k, { weight: 900, spacing: lerp(size * 0.18, size * 0.08, u) });
  }

  function panel(x: number, y: number, w: number, h: number, alpha: number, accent = false) {
    ctx.save(); ctx.globalAlpha = alpha;
    ctx.fillStyle = 'rgba(22,21,27,.94)'; ctx.strokeStyle = accent ? GOLD : '#3a3744'; ctx.lineWidth = accent ? 3 : 2;
    ctx.beginPath(); ctx.roundRect(x, y, w, h, 18); ctx.fill(); ctx.stroke();
    ctx.restore();
  }

  function project(p: THREE.Vector3) { const q = p.clone().project(camera); return { x: (q.x + 1) / 2 * W, y: (1 - q.y) / 2 * H, front: q.z < 1 }; }

  function overlay(t: number) {
    // colour grade: cool and muted at first, warm candlelight later
    const cool = t < 16.9 ? 0.26 : lerp(0.26, 0, smooth(16.9, 26, t));
    const warm = lerp(0, 0.12, smooth(16.9, 30, t));
    ctx.save();
    ctx.globalCompositeOperation = 'soft-light';
    if (cool > 0.005) { ctx.fillStyle = `rgba(70,90,150,${cool})`; ctx.fillRect(0, 0, W, H); }
    if (warm > 0.005) { ctx.fillStyle = `rgba(255,170,90,${warm})`; ctx.fillRect(0, 0, W, H); }
    ctx.restore();
    const g = ctx.createRadialGradient(W / 2, H / 2, H * 0.32, W / 2, H / 2, H * 0.95);
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, `rgba(0,0,0,${t < DROP ? 0.6 : 0.42})`);
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

    // floating +EXP
    for (const p of popups) {
      const age = t - p.t; if (age > 1.4) continue;
      const s = project(p.at.clone().add(v(0, age * 0.5, 0)));
      if (s.front) text(p.text, s.x, s.y, 40, GOLD, 1 - Math.max(0, age - 0.9) / 0.5, { weight: 900 });
    }

    // 3: logo reveal over the crane
    if (t > DROP + 0.4 && t < 33.2) gameTitle(t, DROP + 0.4, 33.0, 330);

    // 4: gather / remember / celebrate
    title('GATHER.', t, 33.3, 35.9, 168, 96, GOLD);
    title('REMEMBER.', t, 36.2, 38.7, 168, 96, GOLD);
    title('CELEBRATE.', t, 39.0, 41.7, 168, 96, GOLD);
    if (t > 33 && t < 44) text('In-engine footage · staged', W - 40, H - 40, 20, MUTED, 0.75, { weight: 600, align: 'right', stroke: false });

    // 5: create a memorial
    if (t > 44.1 && t < 55.4) {
      title('CREATE A MEMORIAL', t, 44.1, 55.3, 92, 64, INK);
      text('NEAR & Solana memes · paid in NEAR · Memorial NFTs on NEAR', W / 2, 150, 26, GOLD, win(t, 44.6, 55.3), { weight: 700 });
    }

    // 6: EXP, levels and the NFT
    if (t > 55.5 && t < 60.5) {
      title('EVERY OFFERING EARNS EXP', t, 55.7, 58.0, 104, 60, INK);
      title('SHARED GRAVE PROGRESSION', t, 58.2, 60.4, 104, 60, INK);
      expBar(t);
    }
    if (levelBanner && t - levelBanner.t < 1.1 && t < 60.5) {
      const age = t - levelBanner.t, k = win(age, 0, 1.1, 0.15), u = easeOut(age / 0.4);
      const name = GRAVE_LEVELS[levelBanner.level - 1].name;
      text(`LV ${levelBanner.level}`, W / 2, 470 - (1 - u) * 20, 120, GOLD, k, { weight: 900 });
      text(name.toUpperCase(), W / 2, 560, 46, INK, k, { weight: 900, spacing: 6 });
    }
    if (t > 60.4 && t < 70) nftCard(t);

    // 7: the flow
    if (t > 72.4 && t < 84.8) flow(t);

    // 8: title card
    if (t > 90.0) endCard(t);

    // letterbox: closed until the drop, then it opens on the beat
    const bar = t < DROP ? BAR : BAR * (1 - smooth(DROP, DROP + 1.25, t));
    if (bar > 0.5) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, Math.round(bar)); ctx.fillRect(0, H - Math.round(bar), W, Math.round(bar) + 1); }
    if (showCaptions) captions(t);
    // fade in from black, out at the end
    const black = t < 1.6 ? 1 - smooth(0, 1.6, t) : t > END - 0.9 ? smooth(END - 0.9, END, t) : 0;
    if (black > 0.002) { ctx.fillStyle = `rgba(0,0,0,${black})`; ctx.fillRect(0, 0, W, H); }
  }

  /** Overshooting ease for bouncy pops. */
  const back = (u: number) => { const c = 2.2, x = clamp(u, 0, 1) - 1; return 1 + (c + 1) * x * x * x + c * x * x; };

  /**
   * A game-style title: the logo bounces in, then each letter of REST IN PUMP drops in with a bounce, chunky and
   * extruded (cream on a dark gold edge), wobbling a little; the tagline sits on a dark pill underneath.
   */
  function gameTitle(t: number, a: number, b: number, cy: number) {
    const k = win(t, a, b, 0.4);
    if (k <= 0) return;
    if (logo) {
      const u = back((t - a) / 0.55), s = 190 * u, bob = Math.sin(t * 3.1) * 6;
      ctx.save(); ctx.globalAlpha = k; ctx.translate(W / 2, cy + bob); ctx.rotate(Math.sin(t * 2.3) * 0.05);
      ctx.shadowColor = 'rgba(241,199,107,.6)'; ctx.shadowBlur = 50; ctx.drawImage(logo, -s / 2, -s / 2, s, s); ctx.restore();
    }
    const word = 'REST IN PUMP', size = 150;
    ctx.save();
    ctx.font = `900 ${size}px ${SANS}`;
    const widths = [...word].map((ch) => ctx.measureText(ch).width + 6);
    const total = widths.reduce((x, y) => x + y, 0);
    let x = W / 2 - total / 2;
    [...word].forEach((ch, i) => {
      const w = widths[i]; const cx = x + w / 2; x += w;
      if (ch === ' ') return;
      const at = a + 0.35 + i * 0.055, u = clamp((t - at) / 0.5, 0, 1);
      if (u <= 0) return;
      const drop = (1 - back(u)) * -160, rot = Math.sin(t * 4 + i * 0.9) * 0.05 + (1 - u) * 0.4, sc = 0.6 + 0.4 * back(u);
      const yy = cy + 200 + drop + Math.sin(t * 3 + i * 0.7) * 4;
      ctx.save(); ctx.globalAlpha = k; ctx.translate(cx, yy); ctx.rotate(rot); ctx.scale(sc, sc);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round'; ctx.lineWidth = 22; ctx.strokeStyle = '#120d06';
      for (let d = 12; d >= 1; d -= 1) { ctx.fillStyle = d > 6 ? '#3b2a0e' : '#9c7a2c'; ctx.strokeText(ch, 0, d); ctx.fillText(ch, 0, d); }
      ctx.strokeText(ch, 0, 0);
      const gr = ctx.createLinearGradient(0, -size * 0.45, 0, size * 0.45);
      gr.addColorStop(0, '#fff8e4'); gr.addColorStop(0.55, '#ffe9a8'); gr.addColorStop(1, GOLD);
      ctx.fillStyle = gr; ctx.fillText(ch, 0, 0);
      ctx.restore();
    });
    ctx.restore();
    const tk = win(t, a + 1.2, b, 0.4);
    if (tk > 0) {
      const u = back((t - a - 1.2) / 0.5), pw = 920 * Math.max(0.2, u), py = cy + 330;
      ctx.save(); ctx.globalAlpha = tk * k; ctx.fillStyle = 'rgba(22,21,27,.9)'; ctx.strokeStyle = GOLD; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.roundRect(W / 2 - pw / 2, py - 38, pw, 76, 38); ctx.fill(); ctx.stroke(); ctx.restore();
      if (u > 0.6) text('Every offering keeps the memory alive.', W / 2, py, 40, GOLD, tk * k, { weight: 600, family: SERIF, italic: true, stroke: false });
    }
  }

  /** The game-style EXP bar for the lonely grave (bottom left). */
  function expBar(t: number) {
    if (!lonely) return;
    const k = win(t, 55.6, 60.4, 0.3), x = 80, y = H - 250, w = 560, h = 132;
    panel(x, y, w, h, k);
    const lvl = lonely.level, next = nextLevelIn(lonely.exp), min = GRAVE_LEVELS[lvl - 1].min, max = next === null ? lonely.exp : lonely.exp + next;
    text(`$${lonelyCoin.symbol}`, x + 28, y + 36, 30, GOLD, k, { weight: 900, align: 'left' });
    text(`LV ${lvl} · ${GRAVE_LEVELS[lvl - 1].name}`, x + w - 28, y + 36, 24, INK, k, { weight: 800, align: 'right' });
    ctx.save(); ctx.globalAlpha = k;
    ctx.fillStyle = '#0f0e14'; ctx.beginPath(); ctx.roundRect(x + 28, y + 64, w - 56, 22, 11); ctx.fill();
    const fill = next === null ? 1 : clamp((lonely.exp - min) / Math.max(1, max - min), 0, 1);
    ctx.fillStyle = GOLD; ctx.beginPath(); ctx.roundRect(x + 28, y + 64, Math.max(22, (w - 56) * fill), 22, 11); ctx.fill();
    ctx.restore();
    text(`COMMUNITY EXP ${lonely.exp.toLocaleString('en-US')}${next === null ? '' : ` / ${max.toLocaleString('en-US')}`}`, x + 28, y + 110, 20, MUTED, k, { weight: 700, align: 'left', stroke: false });
  }

  /** The NFT art without its white border (trimmed once), drawn as a full card. */
  const cards: (HTMLCanvasElement | HTMLImageElement | null)[] = [];
  function cardArt(i: number) {
    if (cards[i] !== undefined) return cards[i];
    const im = nfts[i];
    if (!im) return (cards[i] = null);
    const c = document.createElement('canvas'); c.width = im.naturalWidth || 1080; c.height = im.naturalHeight || 1380;
    const g = c.getContext('2d')!; g.drawImage(im, 0, 0, c.width, c.height);
    let box = { x: 0, y: 0, w: c.width, h: c.height };
    try {
      const d = g.getImageData(0, 0, c.width, c.height).data, Wd = c.width, Hd = c.height;
      const edge = (x: number, y: number) => { const p = (y * Wd + x) * 4; return d[p + 3] < 40 || (d[p] > 225 && d[p + 1] > 225 && d[p + 2] > 225); };
      const rowEdge = (y: number) => { let n = 0; for (let x = 0; x < Wd; x += 4) if (!edge(x, y)) n++; return n < Wd / 4 * 0.6; };
      const colEdge = (x: number, y0: number, y1: number) => { let n = 0; for (let y = y0; y < y1; y += 4) if (!edge(x, y)) n++; return n < (y1 - y0) / 4 * 0.6; };
      let top = 0; while (top < Hd / 3 && rowEdge(top)) top++;
      let bot = Hd - 1; while (bot > Hd * 2 / 3 && rowEdge(bot)) bot--;
      let left = 0; while (left < Wd / 3 && colEdge(left, top, bot)) left++;
      let right = Wd - 1; while (right > Wd * 2 / 3 && colEdge(right, top, bot)) right--;
      const inset = 6;
      box = { x: left + inset, y: top + inset, w: right - left - inset * 2, h: bot - top - inset * 2 };
    } catch { box = { x: c.width * 0.05, y: c.height * 0.04, w: c.width * 0.9, h: c.height * 0.92 }; }
    const out2 = document.createElement('canvas'); out2.width = box.w; out2.height = box.h;
    out2.getContext('2d')!.drawImage(c, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
    return (cards[i] = out2);
  }

  /** NFT showcase: the card floats in, then evolves three times like a game monster (charge, flash, level up). */
  function nftCard(t: number) {
    const k = win(t, 60.45, 69.95, 0.4);
    ctx.fillStyle = `rgba(6,5,10,${0.66 * k})`; ctx.fillRect(0, 0, W, H);
    let lvl = 0; for (const e of EVOLVE) if (t >= e + 1.0) lvl++;
    const charging = EVOLVE.find((e) => t >= e && t < e + 1.0);
    const sinceFlash = Math.min(...EVOLVE.map((e) => (t >= e + 1.0 ? t - e - 1.0 : 99)));
    const ch = 630, cx = W / 2, cy = H / 2 + 40;
    const enter = back((t - 60.5) / 0.7);
    const art = cardArt(lvl);
    const ar = art ? art.width / art.height : 1080 / 1380, cw = ch * ar;
    // light rays behind the card, stronger at the legendary level
    ctx.save(); ctx.globalAlpha = k * (0.18 + 0.12 * lvl); ctx.translate(cx, cy); ctx.rotate(t * 0.25);
    for (let i = 0; i < 14; i++) { ctx.rotate(Math.PI / 7); ctx.fillStyle = i % 2 ? 'rgba(241,199,107,.5)' : 'rgba(255,240,200,.25)'; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(-90, -900); ctx.lineTo(90, -900); ctx.fill(); }
    ctx.restore();
    const pop = sinceFlash < 0.35 ? 1 + 0.16 * Math.sin((sinceFlash / 0.35) * Math.PI) : 1;
    const shake = charging !== undefined ? Math.sin(t * 70) * 6 * ((t - charging) / 1.0) : 0;
    ctx.save(); ctx.globalAlpha = k;
    ctx.translate(cx + shake, cy + (1 - enter) * 500 + Math.sin(t * 1.8) * 10);
    ctx.rotate(Math.sin(t * 1.3) * 0.03 + (1 - enter) * 0.5);
    const sc = 0.4 + 0.6 * enter; ctx.scale(sc * pop * (0.92 + 0.08 * Math.abs(Math.cos(t * 0.9))), sc * pop);
    ctx.shadowColor = `rgba(241,199,107,${0.5 + 0.12 * lvl})`; ctx.shadowBlur = 50 + 20 * lvl;
    ctx.beginPath(); ctx.roundRect(-cw / 2, -ch / 2, cw, ch, 34); ctx.fillStyle = '#1b1720'; ctx.fill();
    ctx.shadowBlur = 0;
    ctx.save(); ctx.beginPath(); ctx.roundRect(-cw / 2, -ch / 2, cw, ch, 34); ctx.clip();
    if (art) ctx.drawImage(art, -cw / 2, -ch / 2, cw, ch);
    // the evolution glow: the card brightens and pulses faster and faster, then turns white
    if (charging !== undefined) {
      const u = (t - charging) / 1.0, pulse = 0.5 + 0.5 * Math.sin(u * u * 60);
      ctx.fillStyle = `rgba(255,255,255,${Math.min(1, u * 0.7 + pulse * u * 0.5)})`; ctx.fillRect(-cw / 2, -ch / 2, cw, ch);
    }
    if (sinceFlash < 0.5) { ctx.fillStyle = `rgba(255,255,255,${1 - sinceFlash / 0.5})`; ctx.fillRect(-cw / 2, -ch / 2, cw, ch); }
    ctx.restore();
    ctx.lineWidth = 8; ctx.strokeStyle = lvl === 3 ? '#ffe08a' : GOLD; ctx.beginPath(); ctx.roundRect(-cw / 2, -ch / 2, cw, ch, 34); ctx.stroke();
    ctx.restore();
    // sparkles around the card
    for (let i = 0; i < 26; i++) {
      const a2 = i * 2.39 + t * (0.6 + (i % 5) * 0.1), rad = 420 + 60 * Math.sin(t * 2 + i), tw = 0.5 + 0.5 * Math.sin(t * 6 + i * 1.7);
      const sx = cx + Math.cos(a2) * rad * 0.9, sy = cy + Math.sin(a2) * rad * 0.62;
      ctx.save(); ctx.globalAlpha = k * tw * (0.4 + 0.15 * lvl); ctx.fillStyle = '#fff3c4';
      ctx.translate(sx, sy); ctx.rotate(t + i); const z = 6 + 6 * tw;
      ctx.beginPath(); ctx.moveTo(0, -z); ctx.lineTo(z * 0.3, 0); ctx.lineTo(0, z); ctx.lineTo(-z * 0.3, 0); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.moveTo(-z, 0); ctx.lineTo(0, z * 0.3); ctx.lineTo(z, 0); ctx.lineTo(0, -z * 0.3); ctx.closePath(); ctx.fill(); ctx.restore();
    }
    // the flash fills the screen for a moment
    if (sinceFlash < 0.3) { ctx.fillStyle = `rgba(255,250,235,${0.55 * (1 - sinceFlash / 0.3)})`; ctx.fillRect(0, 0, W, H); }
    if (sinceFlash < 1.3) {
      const u = back(sinceFlash / 0.4);
      text('LEVEL UP!', cx, cy - ch / 2 - 10 - u * 20, 74, GOLD, k * win(sinceFlash, 0, 1.3, 0.2), { weight: 900, spacing: 4 });
    }
    text(`LV ${lvl + 1} · ${GRAVE_LEVELS[lvl].name.toUpperCase()}`, cx, cy + ch / 2 + 46, 34, lvl === 3 ? '#ffe08a' : INK, k, { weight: 900, spacing: 3 });
    title('DYNAMIC MEMORIAL NFTs', t, 60.7, 69.9, 84, 60, GOLD);
    text('Real NEAR NFTs that evolve with the grave · one per wallet, per grave', W / 2, 140, 26, INK, win(t, 61.0, 69.9) * k, { weight: 700 });
  }

  /** Revenue flow: graves and offerings -> revenue -> 20% team / 80% $WTH buyback -> holders. */
  function flow(t: number) {
    const k = win(t, 72.4, 84.7, 0.45);
    ctx.fillStyle = `rgba(6,5,10,${0.62 * k})`; ctx.fillRect(0, 0, W, H);
    title('MORE THAN TRADING.', t, 72.7, 84.6, 150, 76, GOLD);
    const node = (at: number, x: number, y: number, w: number, h: number, head: string, sub: string, accent = false, icon?: HTMLImageElement | null) => {
      const a = win(t, at, 84.6, 0.35) * k, u = easeOut((t - at) / 0.45);
      if (a <= 0) return;
      const yy = y + (1 - u) * 22;
      panel(x - w / 2, yy - h / 2, w, h, a, accent);
      let tx = x;
      if (icon) { ctx.save(); ctx.globalAlpha = a; ctx.drawImage(icon, x - w / 2 + 22, yy - 32, 64, 64); ctx.restore(); tx = x + 44; }
      text(head, tx, yy - 16, 34, accent ? GOLD : INK, a, { weight: 900, spacing: 2, stroke: false });
      text(sub, tx, yy + 26, 22, MUTED, a, { weight: 600, stroke: false });
    };
    const arrow = (at: number, x0: number, y0: number, x1: number, y1: number) => {
      const u = clamp((t - at) / 0.45, 0, 1) * k; if (u <= 0) return;
      ctx.save(); ctx.strokeStyle = GOLD; ctx.lineWidth = 5; ctx.lineCap = 'round'; ctx.globalAlpha = k;
      const xe = lerp(x0, x1, u), ye = lerp(y0, y1, u);
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(xe, ye); ctx.stroke();
      if (u > 0.95) { const ang = Math.atan2(y1 - y0, x1 - x0); ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x1 - 18 * Math.cos(ang - 0.5), y1 - 18 * Math.sin(ang - 0.5)); ctx.moveTo(x1, y1); ctx.lineTo(x1 - 18 * Math.cos(ang + 0.5), y1 - 18 * Math.sin(ang + 0.5)); ctx.stroke(); }
      ctx.restore();
    };
    const y1 = 420, y2 = 640;
    node(73.4, 340, y1, 440, 130, 'GRAVES + OFFERINGS', 'paid in NEAR');
    arrow(74.2, 570, y1, 720, y1);
    node(74.6, 960, y1, 420, 130, 'PLATFORM REVENUE', 'collects in the buyback account');
    arrow(75.4, 1180, y1, 1340, y1);
    node(75.8, 1600, y1 - 4, 500, 150, '80% $WTH BUYBACK', 'bought on RHEA', true, logo);
    node(76.2, 960, y2 + 50, 300, 100, '20% TEAM', 'whatthehoot.near');
    arrow(76.0, 960, y1 + 70, 960, y2);
    arrow(77.0, 1600, y1 + 80, 1600, y2 - 6);
    node(77.4, 1600, y2 + 60, 460, 130, 'HOLDER DISTRIBUTION', 'to eligible $WTH holders');
    text('Buybacks run when revenue reaches the set threshold. No guaranteed rewards.', W / 2, 868, 24, MUTED, win(t, 78.0, 84.6) * k, { weight: 600, stroke: false });
    text('GAME ACTIVITY  →  $WTH BUYBACKS', W / 2, 238, 44, INK, win(t, 79.8, 84.6) * k, { weight: 900, spacing: 3 });
  }

  function endCard(t: number) {
    const k = smooth(90.0, 91.0, t);
    ctx.fillStyle = `rgba(8,7,12,${0.72 * k})`; ctx.fillRect(0, 0, W, H);
    gameTitle(t, 90.1, END + 5, 250);
    const b = smooth(92.0, 92.6, t), u = back((t - 92.0) / 0.5);
    if (b > 0) {
      ctx.save(); ctx.globalAlpha = b; ctx.translate(W / 2, 760); ctx.scale(0.8 + 0.2 * u, 0.8 + 0.2 * u);
      ctx.font = `800 56px ${SANS}`; const a1 = 'Play now at ', a2 = 'rip.whatthehoot.lol';
      const w1 = ctx.measureText(a1).width, w2 = ctx.measureText(a2).width, x0 = -(w1 + w2) / 2;
      ctx.textBaseline = 'middle'; ctx.textAlign = 'left'; ctx.lineWidth = 8; ctx.strokeStyle = 'rgba(8,6,12,.85)'; ctx.lineJoin = 'round';
      ctx.strokeText(a1, x0, 0); ctx.fillStyle = INK; ctx.fillText(a1, x0, 0);
      ctx.strokeText(a2, x0 + w1, 0); ctx.fillStyle = GOLD; ctx.fillText(a2, x0 + w1, 0);
      ctx.restore();
    }
  }

  /** Closed captions: the narration line on screen while it is spoken. */
  let capDur: Record<string, number> = {};
  function captions(t: number) {
    for (const l of LINES) {
      const d = capDur[l.id] ?? l.text.split(' ').length * 0.36;
      if (t < l.at || t > l.at + d + 0.25) continue;
      const k = win(t, l.at, l.at + d + 0.25, 0.15);
      ctx.save(); ctx.font = `600 34px ${SANS}`;
      const tw = ctx.measureText(l.text).width, y = t < DROP + 0.6 ? H - BAR - 46 : H - 78;
      ctx.globalAlpha = k * 0.75; ctx.fillStyle = '#000'; ctx.beginPath(); ctx.roundRect(W / 2 - tw / 2 - 18, y - 27, tw + 36, 54, 10); ctx.fill();
      ctx.globalAlpha = k; ctx.fillStyle = '#ffffff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(l.text, W / 2, y + 1);
      ctx.restore();
    }
  }

  // ---- simulation and drawing
  /** force: never wait (jumping to a moment for a quick look skips the real network steps). */
  function simulate(dt: number, force = false): boolean {
    const t = clock;
    for (const e of events) {
      if (e.done || t < e.at) continue;
      if (e.fn() === false && !force) return false;       // waiting on something real (the search, a lookup): hold the clock
      e.done = true;
    }
    for (const a of all) if (a.shown) a.update(dt, t);
    bursts.update(dt);
    flash.intensity *= Math.exp(-3 * dt);
    if (pop) {
      const obj = field.graveObject(pop.plot), u = clamp((t - pop.at) / 0.7, 0, 1);
      obj?.scale.setScalar(u >= 1 ? 1 : 0.25 + 0.75 * (1 - Math.pow(1 - u, 3)) + Math.sin(u * Math.PI) * 0.18);
      if (u >= 1) pop = null;
    }
    field.update(t, focusPlot ? { kind: 'empty', plot: PX(focusPlot) } : null);
    look(t);
    return true;
  }
  const pushers: THREE.Vector3[] = [];
  function draw(smoothing: number) {
    const t = clock;
    const cut = shot(t);
    if (cut || smoothing <= 0) { smPos.copy(camPos); smLook.copy(camLook); }
    else { const k = 1 - Math.exp(-6 * smoothing); smPos.lerp(camPos, k); smLook.lerp(camLook, k); }
    camera.position.copy(smPos); camera.lookAt(smLook);
    pushers.length = 0;
    for (const a of all.filter((x) => x.shown).sort((p, q) => p.pos.distanceToSquared(smLook) - q.pos.distanceToSquared(smLook)).slice(0, 8)) pushers.push(a.pos);
    world.setGrassPushers(pushers);
    world.update(t, camera, smLook);
    renderer.render(world.scene, camera);
    ctx.drawImage(renderer.domElement, 0, 0, W, H);
    overlay(t);
  }

  /** Builds one grave of every level (with every gift) and shows every owl once, so nothing compiles mid-film. */
  function warmUp() {
    const lv: GraveLevel[] = [1, 2, 3, 4];
    field.setGraves(lv.map((l, i) => grave(33 + i, pickCoin(i), ITEMS_BY_LEVEL[l])));
    for (const [i, a] of all.entries()) a.place(v(-10 + i, 0, 10), 0);
    camera.position.set(0, 8, 18); camera.lookAt(0, 0, 0);
    renderer.compile(world.scene, camera);
    renderer.render(world.scene, camera);
    bursts.burst(v(0, -5, 0), 'dirt', 2); bursts.burst(v(0, -5, 0), 'spark', 2);
    renderer.compile(world.scene, camera);
    bursts.clear();
  }

  // ---- real-time playback (Play / Record video in a browser)
  let playing = false, last = realNow();
  let recorder: MediaRecorder | null = null;
  const loop = () => {
    if (capture) return;
    const now = realNow(), dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    if (playing) { if (simulate(dt)) clock += dt; }
    draw(playing ? dt : 0);
    if (playing && clock >= END) finish();
    requestAnimationFrame(loop);
  };
  setup(); warmUp(); setup();
  draw(0);
  if (!capture) requestAnimationFrame(loop);
  msg.textContent = 'Ready. Play to watch, or Record video to save it in real time (keep this tab in front). For the final trailer use trailer/render.mjs.';

  async function start(record: boolean) {
    audio.start();
    if (audio.muted) audio.setMuted(false);
    ui.hidden = true;
    setup(); warmUp(); setup();
    clock = 0; playing = false;
    for (let i = 0; i < 20; i++) await new Promise((res) => requestAnimationFrame(res));
    clock = 0; playing = true; last = realNow();
    if (!record) return;
    recorder = makeRecorder('rest-in-pump-trailer-realtime');
    recorder.start(1000);
  }
  function makeRecorder(name: string): MediaRecorder {
    const stream = out.captureStream(30);
    for (const tr of audio.recordStream()?.getAudioTracks() ?? []) stream.addTrack(tr);
    const types = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm'];
    const type = types.find((x) => MediaRecorder.isTypeSupported(x)) ?? '';
    const chunks: Blob[] = [];
    const rec = new MediaRecorder(stream, { mimeType: type || undefined, videoBitsPerSecond: 14_000_000 });
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.onstop = () => {
      const blob = new Blob(chunks, { type: rec.mimeType || type || 'video/webm' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${name}.${blob.type.includes('mp4') ? 'mp4' : 'webm'}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
      msg.textContent = `Saved ${a.download} (${(blob.size / 1e6).toFixed(1)} MB).`;
      if (recorder === rec) recorder = null;
    };
    return rec;
  }
  function finish() {
    playing = false;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    msg.textContent = 'The end. Play again, or Record video.';
    ui.hidden = false;
  }
  (ui.querySelector('#film-play') as HTMLButtonElement).onclick = () => void start(false);
  (ui.querySelector('#film-rec') as HTMLButtonElement).onclick = () => void start(true);
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && playing) { recorder?.stop(); playing = false; ui.hidden = false; msg.textContent = 'Stopped.'; } });

  // ---- frame-by-frame API for trailer/render.mjs (and for checking single moments: __film.seek(30))
  (window as unknown as Record<string, unknown>).__film = {
    end: END,
    cues: () => ({ sfx: [...sfx], lines: LINES, music: MUSIC, drop: DROP, end: END }),
    /** Real narration lengths (seconds per line id), so captions match the voice. */
    setCaptions: (d: Record<string, number>) => { capDur = d; },
    /** Starts a take at time `from` (replays the story up to it without drawing). */
    begin: (from = 0) => {
      setup(); warmUp(); setup();
      clock = 0;
      while (clock < from - 1e-6) { if (!simulate(1 / 30)) break; clock = Math.min(from, clock + 1 / 30); }
      draw(0);
      return { end: END };
    },
    /** Advances one frame. Returns false (without advancing) while the story waits on a real network answer. */
    frame: (dt: number) => {
      if (!simulate(dt)) { draw(0.0001); return { advanced: false, t: clock }; }
      clock += dt;
      draw(dt);
      return { advanced: true, t: clock };
    },
    seek: (s: number) => { setup(); clock = 0; playing = false; ui.hidden = true; while (clock < s) { simulate(1 / 30, true); clock = Math.min(s, clock + 1 / 30); } draw(0); },
  };
  (window as unknown as Record<string, unknown>).__filmReady = true;
}
