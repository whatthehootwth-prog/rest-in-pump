import * as THREE from 'three';
import { clamp, damp, lerp, lerpAngle, rr } from '../util/math.ts';
import { blobShadowTexture } from '../util/textures.ts';
import { EYES, RING, RIG, getOwlTemplate } from './model.ts';

/** The walk styles. Each player gets one at random from the server. Index = PlayerState.walk on the wire. */
export const WALKS = [
  { id: 'goose', name: 'Goose kick' }, { id: 'noodle', name: 'Noodle legs' }, { id: 'flail', name: 'Panic flail' },
  { id: 'crab', name: 'Crab stomp' }, { id: 'zombie', name: 'Zombie shuffle' }, { id: 'windmill', name: 'Windmill arms' },
  { id: 'pogo', name: 'Pogo hop' }, { id: 'disco', name: 'Disco point' }, { id: 'glitch', name: 'Glitch mode' },
] as const;

/** What drives one frame of animation (same for the local player and for remote players). */
/** Emotes (index = PlayerState.emote; 0 = none). */
export const EMOTES = [
  { id: 'none', name: '' }, { id: 'dance', name: 'Dance' }, { id: 'club', name: 'Club' },
  { id: 'pray', name: 'Pray' }, { id: 'cry', name: 'Cry' }, { id: 'roll', name: 'Roll' },
] as const;

export interface MotionInput {
  emote: number;
  speed: number;
  phase: number;
  air: boolean;
  vy: number;
  land: number;
}

export interface Owl {
  root: THREE.Group;
  blob: THREE.Mesh;
  walk: number;
  setWalk(i: number): void;
  animate(dt: number, t: number, p: MotionInput): void;
  dispose(): void;
}

const blobGeo = new THREE.CircleGeometry(0.4, 32);
const tearGeo = (() => { const g = new THREE.SphereGeometry(0.075, 12, 8); g.scale(1, 1.5, 0.8); return g; })();
const puddleGeo = new THREE.CircleGeometry(0.55, 28);
let tearMat: THREE.MeshBasicMaterial | null = null;
let puddleMat: THREE.MeshBasicMaterial | null = null;
let blobMat: THREE.MeshBasicMaterial | null = null;

/**
 * Creates one owl. Geometry and materials are shared with every other owl; only the scene graph and
 * animation state are per-instance. The walk style comes from the server and never changes.
 */
export function createOwl(): Owl {
  const tpl = getOwlTemplate();
  const root = tpl.root.clone(true);
  const node = (name: string) => {
    const o = root.getObjectByName(name);
    if (!o) throw new Error(`owl node missing: ${name}`);
    return o;
  };
  const rig = node('rig'), body = node('body'), neck = node('neck'), head = node('head');
  const mandible = node('mandible'), tongue = node('tongue');
  const arms: Record<number, THREE.Object3D> = { [-1]: node('arm-1'), 1: node('arm1') };
  const legs: Record<number, THREE.Object3D> = { [-1]: node('leg-1'), 1: node('leg1') };
  const eyes = EYES.map((e, i) => ({ grp: node(`eye${i}`), pupil: node(`pupil${i}`), e, surf: tpl.pupilSurfaces[i], x: e.pupil[0] as number, y: e.pupil[1] as number }));
  const HIP = RIG.hip;

  blobMat ??= new THREE.MeshBasicMaterial({ map: blobShadowTexture(), transparent: true, depthWrite: false });
  const blob = new THREE.Mesh(blobGeo, blobMat);
  blob.rotation.x = -Math.PI / 2; blob.renderOrder = 1;

  const setPupil = (p: (typeof eyes)[number]) => {
    const lim = p.e.r - RING - p.e.pr - 0.004, l = Math.hypot(p.x, p.y);
    if (l > lim) { p.x *= lim / l; p.y *= lim / l; }
    p.pupil.position.set(p.x, p.y, p.surf.z(p.x, p.y));
  };
  eyes.forEach(setPupil);

  // tears (only visible while crying), in head units: a fountain of drops shooting sideways out of each eye
  tearMat ??= new THREE.MeshBasicMaterial({ color: 0x9fdcff, transparent: true, opacity: 0.9, depthWrite: false });
  const TEARS_PER_EYE = 9;
  // a puddle of tears grows under the owl while it cries
  puddleMat ??= new THREE.MeshBasicMaterial({ color: 0x7fc8f0, transparent: true, opacity: 0.5, depthWrite: false });
  const puddle = new THREE.Mesh(puddleGeo, puddleMat);
  puddle.rotation.x = -Math.PI / 2; puddle.position.y = 0.015; puddle.scale.setScalar(0.001); puddle.visible = false; puddle.renderOrder = 1;
  root.add(puddle);
  const tears = EYES.flatMap((e, i) => Array.from({ length: TEARS_PER_EYE }, (_, k) => {
    const m = new THREE.Mesh(tearGeo, tearMat!);
    m.visible = false; head.add(m);
    return { m, x: e.x, y: e.y - e.r * 0.55, dir: e.x < 0 ? -1 : 1, ph: k / TEARS_PER_EYE + i * 0.07, spread: 0.75 + (k % 3) * 0.2 };
  }));

  const st = {
    act: 'none', actT: 0, actDur: 1, timer: rr(1, 4), tilt: 0, look: [0, 0], turn: 0, mouth: 0.2,
    blinkT: rr(1, 4), blink: 0, gT: 0, g: new Array<number>(12).fill(0),
  };

  const owl: Owl = {
    root, blob, walk: 0,
    setWalk(i: number) {
      const w = ((Math.trunc(i) % WALKS.length) + WALKS.length) % WALKS.length;
      if (w === owl.walk) return;
      owl.walk = w;
    },
    dispose() { root.removeFromParent(); blob.removeFromParent(); },
    animate(dt, t, p) {
      const walk = clamp(p.speed / 1.8, 0, 1), runA = clamp(p.speed / 1.8 - 1, 0, 1), air = p.air ? 1 : 0;
      const sw = Math.sin(p.phase), cw = Math.cos(p.phase);

      // random antics (cosmetic, local to each viewer)
      st.timer -= dt; st.actT -= dt;
      if (st.timer < 0) {
        st.timer = rr(2.2, 5); const r = Math.random();
        st.act = walk > 0.3 ? (r < 0.22 ? 'scream' : r < 0.45 ? 'headspin' : 'none')
          : r < 0.22 ? 'tilt' : r < 0.42 ? 'scream' : r < 0.6 ? 'headspin' : r < 0.8 ? 'derp' : 'look';
        st.actT = st.actDur = st.act === 'scream' ? 1.0 : st.act === 'headspin' ? 0.9 : st.act === 'derp' ? 1.8 : 2.2;
        st.tilt = rr(0.22, 0.38) * (Math.random() < 0.5 ? -1 : 1); st.look = [rr(-1, 1), rr(-0.6, 1)]; st.turn = rr(-0.6, 0.6);
      }
      const act = st.actT > 0 ? st.act : 'none', scream = act === 'scream' ? 1 : 0;

      // legs + arms: one of many ridiculous walks
      const style = WALKS[owl.walk].id, run = 1 + 0.35 * runA;
      const up = Math.max(air, scream);
      let lean = 0, twist = 0, sway = 0.12, bob = 0.06, hop = 0, peck = 0;
      if (style === 'glitch') { st.gT -= dt; if (st.gT < 0) { st.gT = rr(0.07, 0.2); st.g = st.g.map(() => rr(-1, 1)); } twist = st.g[0] * 0.7; sway = 0.3; }
      const posing = p.emote > 0 && walk < 0.3 && !p.air;
      for (const s of [-1, 1]) {
        const ph = p.phase + (s > 0 ? 0 : Math.PI), sp = Math.sin(ph), cp = Math.cos(ph), g = st.g, k = s > 0 ? 0 : 6;
        let lx = 0, lz = 0, ls = 1, ax = 0, az = 0, as = 1, armSpin: number | null = null;
        switch (style) {
          case 'goose':
            lx = -Math.pow(Math.max(0, sp), 2) * 1.75 + Math.max(0, -sp) * 0.4; ls = 1 + 0.4 * Math.max(0, sp);
            ax = sp * 1.7; az = 0.15; lean = -0.3; bob = 0.1; peck = 1; break;
          case 'noodle':
            lx = sp * 0.95 + Math.sin(t * 7 + s) * 0.2; lz = -0.2 + Math.sin(ph * 2) * 0.42; ls = 1 + 0.3 * Math.max(0, sp);
            ax = Math.sin(ph - 1.3) * 1.4; az = 0.4 + 0.65 * Math.sin(ph * 2 + 0.8); as = 1 + 0.45 * Math.max(0, Math.sin(ph * 2));
            sway = 0.4; twist = Math.sin(p.phase * 0.5) * 0.5; break;
          case 'flail':
            lx = sp * 0.45; lz = Math.max(0, cp) * 0.95; ls = 1 + 0.3 * Math.max(0, cp);
            ax = Math.sin(t * 11 + s * 1.7) * 1.2; az = 1.9 + Math.sin(t * 15 + s * 2.3) * 1.1; as = 1 + 0.55 * Math.abs(Math.sin(t * 9 + s));
            twist = sp * 0.4; peck = 0.6; break;
          case 'crab':
            lx = sp * 0.35; lz = 0.5 + Math.max(0, cp) * 0.5;
            ax = -1.4 + Math.sin(t * 18 + s) * 0.2; az = 0.6 + Math.abs(Math.sin(t * 10 + s * 1.3)) * 0.7; as = 1 + 0.35 * Math.abs(Math.sin(t * 10 + s * 1.3));
            sway = 0.25; bob = 0.03; lean = 0.05; break;
          case 'zombie':
            lx = s > 0 ? sp * 0.85 : sp * 0.12 + 0.25; lz = s > 0 ? 0.04 : 0.2; ls = s > 0 ? 1 + 0.2 * Math.max(0, -sp) : 1;
            ax = -1.6 + Math.sin(t * 3 + s) * 0.12; az = 0.1; as = s > 0 ? 1.6 : 0.85; lean = 0.22; sway = 0.22; twist = sp * 0.18; break;
          case 'windmill':
            lx = -Math.max(0, sp) * 0.95; lz = Math.max(0, cp) * 0.3; ls = 1 + 0.2 * Math.max(0, sp);
            armSpin = (t * (11 + 4 * runA) * s) % (Math.PI * 2); az = 0.4; as = 1.3; lean = 0.08; break;
          case 'pogo':
            lx = s > 0 ? 0.05 : 1.1 + Math.sin(t * 9) * 0.25; lz = s > 0 ? 0.0 : 0.25;
            ax = -0.4; az = 1.3 + Math.sin(t * 22 + s) * 0.9; as = 1.15; hop = Math.abs(Math.sin(p.phase)) * 0.28; lean = 0.15; bob = 0; break;
          case 'disco':
            lx = sp * 0.4; lz = 0.12 + 0.3 * Math.sin(ph * 2);
            if (s > 0) { const hi = Math.sin(p.phase * 0.5) > 0; ax = -0.35; az = hi ? 2.7 : 0.75; as = 1.35; }
            else { ax = 0.55; az = 0.95; as = 0.85; }
            sway = 0.35; twist = Math.sin(p.phase) * 0.45; break;
          case 'glitch':
            lx = g[k] * 1.4; lz = Math.abs(g[k + 1]) * 0.7; ls = 1 + g[k + 2] * 0.35;
            ax = g[k + 3] * 2.2; az = 0.2 + Math.abs(g[k + 4]) * 2.4; as = 1 + g[k + 5] * 0.5; break;
        }
        const w = walk * run, snap = style === 'glitch' ? 45 : 16;
        const leg = legs[s], arm = arms[s];
        // during an emote the emote code below owns the limb rotations (pulling both ways would stop the pose halfway)
        if (posing) { leg.scale.y = damp(leg.scale.y, 1, snap, dt); arm.scale.y = damp(arm.scale.y, 1, snap, dt); continue; }
        leg.rotation.x = damp(leg.rotation.x, lx * w + air * (s > 0 ? 0.5 : -0.25), snap, dt);
        leg.rotation.z = damp(leg.rotation.z, s * (0.04 + lz * walk), snap, dt);
        leg.scale.y = damp(leg.scale.y, lerp(1, ls, walk), snap, dt);
        if (armSpin !== null && walk > 0.25 && !up) arm.rotation.x = armSpin;
        else arm.rotation.x = damp(arm.rotation.x, ax * w * (1 - up) - up * 0.3, snap, dt);
        const flail = up * (2.3 + Math.sin(t * 30 + s) * 0.45);
        arm.rotation.z = damp(arm.rotation.z, s * (0.12 + az * walk * (1 - up) + flail), snap, dt);
        arm.scale.y = damp(arm.scale.y, lerp(1, as, walk) + up * 0.4, snap, dt);
      }
      // rolling lies on the ground; crying kneels (the whole owl drops so the folded legs touch the ground)
      const still = walk < 0.3 && !p.air;
      const ground = still && p.emote === 5 ? 0.13 : still && p.emote === 4 ? -0.2 : 0;
      rig.position.y = damp(rig.position.y, hop * walk + ground, ground !== 0 ? 10 : 25, dt);

      // body: waddle, bounce, squash & stretch, shake while screaming, twirl for the ballerina
      body.position.y = HIP + Math.abs(cw) * bob * walk + 0.006 * Math.sin(t * 2.2) * (1 - walk);
      body.rotation.z = damp(body.rotation.z, sw * (sway + 0.05 * runA) * walk + scream * Math.sin(t * 70) * 0.04, 12, dt);
      body.rotation.x = damp(body.rotation.x, (lean + 0.1 * runA) * walk - air * 0.08 - scream * 0.1, 6, dt);
      body.rotation.y = lerpAngle(body.rotation.y, twist * walk, 1 - Math.exp(-(style === 'glitch' ? 40 : 10) * dt));
      const stretch = air * clamp(p.vy * 0.04, -0.12, 0.16);
      const q = p.land * 0.2 - stretch + (1 - Math.abs(cw)) * 0.04 * walk;
      body.scale.set(1 + q * 0.6, 1 - q, 1 + q * 0.6);

      // head: bobble-head, owl tilts and full head spins, pigeon bob
      neck.rotation.z = damp(neck.rotation.z, -sw * 0.12 * walk + (act === 'tilt' ? st.tilt : 0) + scream * Math.sin(t * 55) * 0.06, 9, dt);
      if (act === 'headspin') neck.rotation.y = (1 - st.actT / st.actDur) * Math.PI * 2;
      else neck.rotation.y = lerpAngle(neck.rotation.y, (act === 'look' ? st.turn : 0) * (1 - walk), 1 - Math.exp(-5 * dt));
      neck.rotation.x = damp(neck.rotation.x, -0.06 * walk - scream * 0.15 + air * 0.1, 7, dt);
      head.position.y = RIG.headY + Math.abs(sw) * 0.02 * walk;
      head.position.z = peck * walk * Math.sin(p.phase * 2) * 0.07;

      // emotes (only while standing on the ground)
      const em = p.emote > 0 && walk < 0.3 && !p.air ? EMOTES[p.emote].id : 'none';
      let emOpen: number | null = null, squint = 1, roll = false, crying = false;
      const k = 14;
      const armTo = (s: number, x: number, z: number) => {
        arms[s].rotation.x = damp(arms[s].rotation.x, x, k, dt);
        arms[s].rotation.z = damp(arms[s].rotation.z, s * z, k, dt);
      };
      const legTo = (s: number, x: number, z: number) => {
        legs[s].rotation.x = damp(legs[s].rotation.x, x, k, dt);
        legs[s].rotation.z = damp(legs[s].rotation.z, s * z, k, dt);
      };
      if (em === 'dance') {                       // a silly routine: chicken dance, noodle wiggle, disco spin (repeat)
        const b = t * Math.PI * 2 * 2.0;           // 120 bpm
        const beat = Math.sin(b), cyc = t % 7.2, move = cyc < 2.4 ? 0 : cyc < 4.8 ? 1 : 2, m = (cyc % 2.4) / 2.4;
        const fast = 30;
        if (move === 0) {
          // chicken dance: elbows flap like wings, head pecks forward, knees knock, little bounce
          const flap = Math.abs(Math.sin(b * 1.5));
          for (const s of [-1, 1]) {
            arms[s].rotation.x = damp(arms[s].rotation.x, -0.9, fast, dt);
            arms[s].rotation.z = damp(arms[s].rotation.z, s * (0.35 + flap * 1.3), fast, dt);
            legTo(s, 0.15, -0.1 + Math.max(0, Math.sin(b + (s > 0 ? 0 : Math.PI))) * 0.45);
          }
          body.position.y = HIP + Math.abs(beat) * 0.05;
          body.rotation.x = damp(body.rotation.x, 0.22, fast, dt);
          body.rotation.z = damp(body.rotation.z, beat * 0.08, fast, dt);
          neck.rotation.x = Math.sin(b * 2) * 0.35 + 0.1;                         // pecking
          emOpen = 0.25 + Math.abs(Math.sin(b * 2)) * 0.6;
        } else if (move === 1) {
          // noodle wiggle: jelly body, floppy wave arms out of sync, bobble head, wobbly knees
          for (const s of [-1, 1]) {
            arms[s].rotation.x = damp(arms[s].rotation.x, Math.sin(b * 0.9 + s * 2) * 1.2, 18, dt);
            arms[s].rotation.z = damp(arms[s].rotation.z, s * (1.4 + Math.sin(b * 1.3 + s) * 1.0), 18, dt);
            legTo(s, Math.sin(b + s) * 0.35, 0.15 + Math.sin(b * 2 + s) * 0.2);
          }
          body.position.y = HIP + Math.sin(b * 2) * 0.03;
          body.rotation.z = damp(body.rotation.z, Math.sin(b * 0.5) * 0.45, 14, dt);  // big side-to-side jelly
          body.rotation.x = damp(body.rotation.x, Math.sin(b * 0.5 + 1) * 0.2, 14, dt);
          body.rotation.y = damp(body.rotation.y, Math.sin(b * 0.25) * 0.5, 10, dt);
          neck.rotation.z = damp(neck.rotation.z, Math.sin(b * 0.75) * 0.5, 14, dt);  // head bobbles round
          neck.rotation.x = damp(neck.rotation.x, Math.cos(b * 0.75) * 0.3, 14, dt);
          emOpen = 0.6 + Math.sin(b) * 0.3;
          squint = 0.55;                                                        // eyes half closed, feeling it
        } else {
          // disco: point up, point down, then a goofy spin with a squat at the end
          const spin = m > 0.55;
          const up = Math.sin(b * 0.5) > 0;
          if (!spin) {
            armTo(1, up ? -0.2 : 0.4, up ? 2.9 : 0.5);                            // right arm points up / down-across
            armTo(-1, 0.3, 0.35 + Math.abs(beat) * 0.2);                          // other hand on hip
            body.rotation.z = damp(body.rotation.z, up ? -0.18 : 0.18, fast, dt);
            body.rotation.y = damp(body.rotation.y, up ? 0.4 : -0.4, 12, dt);
          } else {
            const sp = (m - 0.55) / 0.45;                                          // 0 -> 1 during the spin
            for (const s of [-1, 1]) armTo(s, -0.2, 1.6 + Math.sin(b * 2 + s) * 0.3);   // arms out like a helicopter
            body.rotation.y = sp * Math.PI * 2;
            body.rotation.z = damp(body.rotation.z, 0, 12, dt);
          }
          for (const s of [-1, 1]) legTo(s, 0, 0.12 + (s > 0 && up ? 0.25 : 0));
          const squat = spin && m > 0.9 ? 0.06 : 0;
          body.position.y = HIP + Math.abs(beat) * 0.06 - squat;
          neck.rotation.x = damp(neck.rotation.x, spin ? -0.25 : 0, 12, dt);
          neck.rotation.z = damp(neck.rotation.z, beat * 0.2, 14, dt);
          emOpen = spin ? 1.0 : 0.5 + Math.abs(beat) * 0.3;
        }
      } else if (em === 'club') {                 // rocking out: both hands up and pumping, jumping, swaying, head banging
        const b = t * Math.PI * 2 * 2.13;          // ~128 bpm
        const beat = Math.sin(b), half = Math.sin(b / 2), quarter = Math.sin(b / 4);
        for (const s of [-1, 1]) {
          // both arms straight up, punching the air on every beat and waving wide on the off-beat
          arms[s].rotation.x = damp(arms[s].rotation.x, -0.08 + Math.sin(b * 2 + s) * 0.1, 30, dt);
          arms[s].rotation.z = damp(arms[s].rotation.z, s * (3.0 - Math.max(0, beat) * 0.28 + half * s * 0.1), 30, dt);   // straight up, pumping
          legTo(s, -Math.max(0, Math.sin(b + (s > 0 ? 0 : Math.PI))) * 0.55, 0.1 + Math.abs(half) * 0.12);
        }
        body.position.y = HIP + Math.abs(beat) * 0.1;                                  // jumping to the beat
        body.rotation.z = damp(body.rotation.z, half * 0.24, 20, dt);                   // swaying side to side
        body.rotation.y = damp(body.rotation.y, quarter * 0.6, 12, dt);                 // turning to the crowd
        body.rotation.x = damp(body.rotation.x, 0.1 + Math.max(0, beat) * 0.18, 24, dt);
        neck.rotation.x = Math.sin(b * 2) * 0.6;                                        // head banging
        neck.rotation.z = damp(neck.rotation.z, half * 0.2, 16, dt);
        emOpen = 0.55 + Math.max(0, beat) * 0.6; squint = beat > 0.6 ? 0.35 : 1;       // shouting on the beat
      } else if (em === 'pray') {                 // frantic worship: three quick bows, hands shoot up, one huge bow to the ground
        const c = t % 2.4;
        const quick = c < 1.2, up = c >= 1.2 && c < 1.75;
        const bow = quick ? Math.pow(Math.abs(Math.sin((c / 0.4) * Math.PI)), 0.7) * 0.75
          : up ? -0.25 : Math.sin(((c - 1.75) / 0.65) * Math.PI) * 1.35;
        for (const s of [-1, 1]) {
          if (up) armTo(s, -0.25 + Math.sin(t * 40) * 0.08, 2.85);          // palms together high above the head
          else if (quick) armTo(s, -1.45 + Math.sin(t * 30 + s) * 0.12, -0.62); // hands rubbing together in front
          else armTo(s, -2.6 + bow * 0.4, 0.25);                             // arms sweep forward to the ground
          legTo(s, up ? 0.15 : 0, up ? 0.22 : 0.05);
        }
        body.position.y = HIP + (up ? Math.abs(Math.sin(((c - 1.2) / 0.55) * Math.PI)) * 0.12 : 0);
        body.rotation.x = damp(body.rotation.x, bow, 18, dt);
        body.rotation.z = damp(body.rotation.z, up ? Math.sin(t * 22) * 0.08 : 0, k, dt);
        neck.rotation.x = damp(neck.rotation.x, up ? -0.4 : bow * 0.35, 18, dt);
        emOpen = up ? 0.9 : 0.06 + Math.abs(Math.sin(t * 14)) * 0.22;      // mumbling, then a joyful shout
        squint = up ? 1 : 0.1;
      } else if (em === 'cry') {                  // total breakdown: pound the ground, wail at the sky, collapse sobbing
        const c = t % 5.4, tremble = Math.sin(t * 46) * 0.05;
        const pound = c < 2.2, wail = c >= 2.2 && c < 3.7;
        for (const s of [-1, 1]) {
          const hit = Math.max(0, Math.sin(t * 13 + (s > 0 ? 0 : Math.PI)));
          if (pound) armTo(s, -0.35 - hit * 1.25, 0.25);                     // fists hammering the ground in turn
          else if (wail) armTo(s, -0.5 + Math.sin(t * 24 + s) * 0.3, 2.65 + Math.sin(t * 19 + s) * 0.3);
          else armTo(s, -2.2 + Math.sin(t * 16 + s * 2) * 0.35, 0.55);        // collapsed, weakly beating the floor
          legTo(s, 1.25, 0.12);                                              // kneeling
        }
        body.position.y = HIP + Math.abs(Math.sin(t * (wail ? 14 : 11))) * (wail ? 0.05 : 0.03);
        body.rotation.x = damp(body.rotation.x, pound ? 0.75 + Math.sin(t * 13) * 0.12 : wail ? -0.45 : 1.15 + Math.sin(t * 7) * 0.08, 9, dt);
        body.rotation.z = damp(body.rotation.z, tremble + (pound ? Math.sin(t * 6.5) * 0.12 : 0), 30, dt);
        neck.rotation.x = damp(neck.rotation.x, wail ? -0.7 : pound ? 0.15 + Math.sin(t * 13) * 0.15 : 0.35, 10, dt);
        neck.rotation.z = damp(neck.rotation.z, wail ? Math.sin(t * 5) * 0.3 : tremble * 2, 12, dt);
        emOpen = wail ? 1.15 : 0.85 + Math.sin(t * 9) * 0.25; squint = 0.18; crying = true;
      } else if (em === 'roll') {                 // a crying tantrum: rolling back and forth, kicking and flailing, wailing
        roll = true;
        const r = Math.sin(t * 3.2);
        rig.rotation.x = damp(rig.rotation.x, -1.5, 8, dt);
        rig.rotation.y = damp(rig.rotation.y, r * 2.6, 12, dt);
        rig.position.x = damp(rig.position.x, r * 0.35, 12, dt);
        rig.position.z = damp(rig.position.z, 0.42, 8, dt);
        for (const s of [-1, 1]) {
          armTo(s, Math.sin(t * 19 + s) * 1.1, 1.4 + Math.sin(t * 21 + s * 2) * 1.0);
          legTo(s, Math.sin(t * 17 + (s > 0 ? 0 : Math.PI)) * 0.9, 0.15 + Math.abs(Math.sin(t * 9 + s)) * 0.3);
        }
        emOpen = 0.9 + Math.sin(t * 8) * 0.25; squint = 0.18; crying = true;
      }
      if (!roll) {
        rig.rotation.x = damp(rig.rotation.x, 0, 10, dt);
        rig.rotation.y = damp(rig.rotation.y, 0, 10, dt);
        rig.position.x = damp(rig.position.x, 0, 10, dt);
        rig.position.z = damp(rig.position.z, 0, 10, dt);
      }
      for (const tr of tears) {
        tr.m.visible = crying;
        if (!crying) continue;
        // each drop shoots out sideways and arcs down, then starts again (a fountain, not a trickle)
        const f = (t * 2.4 + tr.ph) % 1;
        tr.m.position.set(tr.x + tr.dir * f * 0.75 * tr.spread, tr.y + f * 0.2 - f * f * 1.1, 0.42 + f * 0.12);
        tr.m.scale.setScalar(1.3 - f * 0.6);
      }
      const ps = damp(puddle.scale.x, crying ? 1 + Math.sin(t * 3) * 0.04 : 0.001, crying ? 0.6 : 3, dt);
      puddle.scale.setScalar(ps);
      puddle.visible = ps > 0.02;

      // mouth + tongue
      const open = emOpen ?? clamp(0.1 + walk * (0.25 + 0.22 * Math.sin(t * 13)) + scream * 1.0 + air * 0.75, 0, 1.15);
      st.mouth = damp(st.mouth, open, 16, dt);
      mandible.rotation.x = tpl.mandibleRest - 0.25 * st.mouth;
      tongue.rotation.z = 0.12 + Math.sin(t * (scream ? 40 : 6)) * (0.1 + 0.25 * scream);

      // blinking
      st.blinkT -= dt;
      if (st.blinkT < 0) { st.blinkT = Math.random() < 0.2 ? 0.25 : rr(2, 5); st.blink = 0.16; }
      st.blink -= dt;
      const lid = Math.min(st.blink > 0 && !scream ? 0.07 : 1, squint);
      for (const ee of eyes) {
        ee.grp.scale.y = damp(ee.grp.scale.y, scream ? 1.18 : lid, 40, dt);
        ee.grp.scale.x = damp(ee.grp.scale.x, scream ? 1.12 : 1, 20, dt);
      }
      // googly pupils
      eyes.forEach((pp, i) => {
        const e = pp.e; let tx: number = e.pupil[0], ty: number = e.pupil[1];
        if (act === 'derp') { const a = t * 8 * (i ? -1 : 1); tx = Math.cos(a) * e.r * 0.5; ty = Math.sin(a) * e.r * 0.5; }
        else if (act === 'look') { tx = st.look[0] * e.r * 0.5; ty = st.look[1] * e.r * 0.4; }
        else if (scream) { tx = (i ? 1 : -1) * e.r * 0.45; ty = e.r * 0.35; }
        tx += Math.sin(t * 19 + i * 2) * 0.012 * walk; ty += Math.cos(t * 23 + i) * 0.012 * walk;
        pp.x = damp(pp.x, tx, 14, dt); pp.y = damp(pp.y, ty, 14, dt);
        setPupil(pp);
      });

      blob.position.set(root.position.x, 0.012, root.position.z);
      blob.scale.setScalar(1 - clamp(root.position.y, 0, 1) * 0.4);
    },
  };
  return owl;
}
