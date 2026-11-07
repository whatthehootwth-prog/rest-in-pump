import * as THREE from 'three';
import { clamp, damp, lerp, lerpAngle, rr } from '../util/math.ts';
import { blobShadowTexture } from '../util/textures.ts';
import { EYES, RING, RIG, getOwlTemplate } from './model.ts';

/** The walk styles, in the order F cycles through them. Index = PlayerState.walk on the wire. */
export const WALKS = [
  { id: 'goose', name: 'Goose kick' }, { id: 'noodle', name: 'Noodle legs' }, { id: 'flail', name: 'Panic flail' },
  { id: 'crab', name: 'Crab stomp' }, { id: 'zombie', name: 'Zombie shuffle' }, { id: 'windmill', name: 'Windmill arms' },
  { id: 'pogo', name: 'Pogo hop' }, { id: 'spin', name: 'Ballerina spin' }, { id: 'disco', name: 'Disco point' }, { id: 'glitch', name: 'Glitch mode' },
] as const;

/** What drives one frame of animation (same for the local player and for remote players). */
export interface MotionInput {
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
let blobMat: THREE.MeshBasicMaterial | null = null;

/**
 * Creates one owl. Geometry and materials are shared with every other owl; only the scene graph and
 * animation state are per-instance. `autoWalk` makes the walk style rotate by itself (local player only;
 * remote players' styles come from the network).
 */
export function createOwl({ autoWalk = false, onWalkChange }: { autoWalk?: boolean; onWalkChange?: (i: number) => void } = {}): Owl {
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

  const st = {
    act: 'none', actT: 0, actDur: 1, timer: rr(1, 4), tilt: 0, look: [0, 0], turn: 0, mouth: 0.2,
    blinkT: rr(1, 4), blink: 0, walkT: 0, gT: 0, g: new Array<number>(12).fill(0),
  };

  const owl: Owl = {
    root, blob, walk: 0,
    setWalk(i: number) {
      const w = ((Math.trunc(i) % WALKS.length) + WALKS.length) % WALKS.length;
      if (w === owl.walk) return;
      owl.walk = w; st.walkT = 0;
      onWalkChange?.(w);
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
      if (autoWalk && walk > 0.3) { st.walkT += dt; if (st.walkT > 8) owl.setWalk(owl.walk + 1); }
      const style = WALKS[owl.walk].id, run = 1 + 0.35 * runA;
      const up = Math.max(air, scream);
      let lean = 0, twist = 0, sway = 0.12, bob = 0.06, hop = 0, spin = false, peck = 0;
      if (style === 'glitch') { st.gT -= dt; if (st.gT < 0) { st.gT = rr(0.07, 0.2); st.g = st.g.map(() => rr(-1, 1)); } twist = st.g[0] * 0.7; sway = 0.3; }
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
          case 'spin':
            lx = s > 0 ? sp * 0.25 : 1.0; lz = s > 0 ? 0.05 : 0.15; ls = s > 0 ? 1 : 1.2;
            ax = -0.15; az = 2.45; as = 1.15; spin = true; bob = 0.03; break;
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
        leg.rotation.x = damp(leg.rotation.x, lx * w + air * (s > 0 ? 0.5 : -0.25), snap, dt);
        leg.rotation.z = damp(leg.rotation.z, s * (0.04 + lz * walk), snap, dt);
        leg.scale.y = damp(leg.scale.y, lerp(1, ls, walk), snap, dt);
        if (armSpin !== null && walk > 0.25 && !up) arm.rotation.x = armSpin;
        else arm.rotation.x = damp(arm.rotation.x, ax * w * (1 - up) - up * 0.3, snap, dt);
        const flail = up * (2.3 + Math.sin(t * 30 + s) * 0.45);
        arm.rotation.z = damp(arm.rotation.z, s * (0.12 + az * walk * (1 - up) + flail), snap, dt);
        arm.scale.y = damp(arm.scale.y, lerp(1, as, walk) + up * 0.4, snap, dt);
      }
      rig.position.y = damp(rig.position.y, hop * walk, 25, dt);

      // body: waddle, bounce, squash & stretch, shake while screaming, twirl for the ballerina
      body.position.y = HIP + Math.abs(cw) * bob * walk + 0.006 * Math.sin(t * 2.2) * (1 - walk);
      body.rotation.z = damp(body.rotation.z, sw * (sway + 0.05 * runA) * walk + scream * Math.sin(t * 70) * 0.04, 12, dt);
      body.rotation.x = damp(body.rotation.x, (lean + 0.1 * runA) * walk - air * 0.08 - scream * 0.1, 6, dt);
      if (spin && walk > 0.25) body.rotation.y = (t * 7.5) % (Math.PI * 2);
      else body.rotation.y = lerpAngle(body.rotation.y, twist * walk, 1 - Math.exp(-(style === 'glitch' ? 40 : 10) * dt));
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

      // mouth + tongue
      const open = clamp(0.1 + walk * (0.25 + 0.22 * Math.sin(t * 13)) + scream * 1.0 + air * 0.75, 0, 1.15);
      st.mouth = damp(st.mouth, open, 16, dt);
      mandible.rotation.x = tpl.mandibleRest - 0.25 * st.mouth;
      tongue.rotation.z = 0.12 + Math.sin(t * (scream ? 40 : 6)) * (0.1 + 0.25 * scream);

      // blinking
      st.blinkT -= dt;
      if (st.blinkT < 0) { st.blinkT = Math.random() < 0.2 ? 0.25 : rr(2, 5); st.blink = 0.16; }
      st.blink -= dt;
      const lid = st.blink > 0 && !scream ? 0.07 : 1;
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
