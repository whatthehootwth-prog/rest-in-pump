import * as THREE from 'three';
import { Rng, fbm2, lerp, noise2, smooth } from '../util/math.ts';
import { canvasTex, textTex } from '../util/textures.ts';
import { merge } from '../owl/toon.ts';
import type { Colliders } from './collision.ts';

/*
 * The graveyard. Built from a fixed seed so every player's world (and every collider) is identical.
 * The gravestones here are scenery only — they are not player-created graves.
 */

export interface World {
  scene: THREE.Scene;
  colliders: Colliders;
  groundHeight(x: number, z: number): number;
  /** Per-frame: keeps sky/moon around the camera, the shadow box on the player, flickers lights. */
  update(t: number, camera: THREE.Camera, focus: THREE.Vector3): void;
  setShadows(on: boolean): void;
  /** Grass bends away from these points (players). Up to 8. */
  setGrassPushers(points: THREE.Vector3[]): void;
}

const HALF = 18;          // fence half-size
const GATE = 1.6;
export const MAX_GRASS_PUSHERS = 8;

export function createWorld(renderer: THREE.WebGLRenderer): World {
  const rng = new Rng(1337);
  const rr = (a: number, b: number) => rng.range(a, b);
  const scene = new THREE.Scene();
  const FOG = new THREE.Color(0x3a2c55);
  scene.fog = new THREE.FogExp2(FOG, 0.024);
  const time = { value: 0 };
  const colliders: Colliders = { circles: [], segs: [] };
  const addBox = (x0: number, z0: number, x1: number, z1: number) =>
    colliders.segs.push([x0, z0, x1, z0], [x1, z0, x1, z1], [x1, z1, x0, z1], [x0, z1, x0, z0]);

  // ------------------------------------------------------------------ textures (cosmetic noise uses Math.random)
  const stoneTex = canvasTex(256, (g, s) => {
    g.fillStyle = '#8d8a92'; g.fillRect(0, 0, s, s);
    for (let i = 0; i < 2600; i++) {
      const v = (110 + Math.random() * 70) | 0;
      g.fillStyle = `rgba(${v},${v},${v + 6},${0.15 + Math.random() * 0.25})`;
      g.beginPath(); g.arc(Math.random() * s, Math.random() * s, Math.random() * 6, 0, 7); g.fill();
    }
    for (let i = 0; i < 70; i++) {
      g.fillStyle = `rgba(${(70 + Math.random() * 30) | 0},${(100 + Math.random() * 40) | 0},60,${0.12 + Math.random() * 0.2})`;
      g.beginPath(); g.arc(Math.random() * s, Math.random() * s, 4 + Math.random() * 22, 0, 7); g.fill();
    }
    for (let i = 0; i < 25; i++) {
      g.strokeStyle = 'rgba(40,38,48,.35)'; g.lineWidth = 1;
      let x = Math.random() * s, y = Math.random() * s; g.beginPath(); g.moveTo(x, y);
      for (let k = 0; k < 6; k++) { x += (Math.random() - 0.5) * 18; y += Math.random() * 12; g.lineTo(x, y); }
      g.stroke();
    }
  });
  stoneTex.colorSpace = THREE.SRGBColorSpace;
  const groundDetail = canvasTex(256, (g, s) => {
    const img = g.createImageData(s, s);
    for (let i = 0; i < s * s; i++) { const v = 200 + Math.random() * 55; img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255; }
    g.putImageData(img, 0, 0);
  }, 90);

  // ------------------------------------------------------------------ sky + moon
  const sky = new THREE.Mesh(new THREE.SphereGeometry(400, 32, 16), new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { uTime: time, uFog: { value: FOG } },
    vertexShader: 'varying vec3 vD; void main(){ vD = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }',
    fragmentShader: `uniform float uTime; uniform vec3 uFog; varying vec3 vD;
      float hs(vec3 p){ return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
      void main(){
        float y = vD.y;
        vec3 c = mix(uFog, vec3(0.045, 0.035, 0.12), smoothstep(0.0, 0.3, y));
        c = mix(c, vec3(0.006, 0.006, 0.025), smoothstep(0.3, 0.95, y));
        vec3 g = floor(vD * 380.); float s = hs(g);
        float st = step(0.9968, s) * smoothstep(0.08, 0.35, y) * (0.55 + 0.45 * sin(uTime * 2.3 + s * 400.));
        c += st * vec3(0.9, 0.9, 1.0);
        gl_FragColor = vec4(c, 1.);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  }));
  sky.renderOrder = -2; scene.add(sky);
  const MOON_DIR = new THREE.Vector3(-0.45, 0.4, -0.8).normalize();
  const moon = new THREE.Mesh(new THREE.CircleGeometry(11, 48), new THREE.MeshBasicMaterial({ color: 0xfff4da, fog: false, toneMapped: false }));
  const moonGlow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: canvasTex(256, (g, s) => {
      const gr = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
      gr.addColorStop(0, 'rgba(210,215,255,.55)'); gr.addColorStop(0.25, 'rgba(170,160,255,.18)'); gr.addColorStop(1, 'rgba(120,100,220,0)');
      g.fillStyle = gr; g.fillRect(0, 0, s, s);
    }),
    blending: THREE.AdditiveBlending, depthWrite: false, fog: false, transparent: true,
  }));
  moonGlow.scale.setScalar(110);
  moon.renderOrder = moonGlow.renderOrder = -1;
  scene.add(moon, moonGlow);

  // ------------------------------------------------------------------ lights
  scene.add(new THREE.HemisphereLight(0x8a93d6, 0x2a2133, 1.15));
  const moonLight = new THREE.DirectionalLight(0xc9d4ff, 2.1);
  moonLight.castShadow = true;
  moonLight.shadow.mapSize.set(2048, 2048);
  Object.assign(moonLight.shadow.camera, { left: -14, right: 14, top: 14, bottom: -14, near: 1, far: 70 });
  moonLight.shadow.bias = -0.0004; moonLight.shadow.normalBias = 0.025;
  const LIGHT_OFF = new THREE.Vector3(9, 22, 14);
  scene.add(moonLight, moonLight.target);

  // ------------------------------------------------------------------ ground
  const groundHeight = (x: number, z: number) => { const t = smooth(34, 70, Math.hypot(x, z)); return t * (3 + 9 * fbm2(x * 0.03, z * 0.03)); };
  const onPath = (x: number, z: number) => (Math.abs(x + Math.sin(z * 0.35) * 0.25) < 1.25 && z > -12.5) || (z > -13 && z < -11.6 && Math.abs(x) < 1.6);
  {
    const g = new THREE.PlaneGeometry(320, 320, 200, 200); g.rotateX(-Math.PI / 2);
    const p = g.attributes.position as THREE.BufferAttribute, col: number[] = [];
    const grass = new THREE.Color(0x2f4232), grass2 = new THREE.Color(0x46502f), dirt = new THREE.Color(0x4f4239), c = new THREE.Color();
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), z = p.getZ(i);
      p.setY(i, groundHeight(x, z));
      c.copy(grass).lerp(grass2, fbm2(x * 0.15, z * 0.15));
      if (onPath(x, z)) c.lerp(dirt, 0.85);
      c.multiplyScalar(0.85 + 0.3 * noise2(x * 0.9, z * 0.9));
      col.push(c.r, c.g, c.b);
    }
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.computeVertexNormals();
    const ground = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, map: groundDetail }));
    ground.receiveShadow = true; scene.add(ground);
  }

  // ------------------------------------------------------------------ grass (wind + bends away from players)
  const pushers = Array.from({ length: MAX_GRASS_PUSHERS }, () => new THREE.Vector3(9999, 0, 9999));
  {
    const H = 0.26, blade = new THREE.PlaneGeometry(0.07, H, 1, 4); blade.translate(0, H / 2, 0);
    const p = blade.attributes.position as THREE.BufferAttribute, n = blade.attributes.normal as THREE.BufferAttribute, col: number[] = [];
    for (let i = 0; i < p.count; i++) {
      const t = p.getY(i) / H; p.setX(i, p.getX(i) * (1 - t * 0.9)); n.setXYZ(i, 0, 1, 0);
      col.push(lerp(0.07, 0.3, t), lerp(0.12, 0.36, t), lerp(0.09, 0.22, t));
    }
    blade.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    mat.onBeforeCompile = (s) => {
      s.uniforms.uTime = time;
      s.uniforms.uPush = { value: pushers };
      s.vertexShader = s.vertexShader.replace('#include <common>', `#include <common>\nuniform float uTime; uniform vec3 uPush[${MAX_GRASS_PUSHERS}];`)
        .replace('#include <project_vertex>', `
vec4 mvPosition = vec4(transformed, 1.0);
#ifdef USE_INSTANCING
  mvPosition = instanceMatrix * mvPosition;
  vec3 base = instanceMatrix[3].xyz;
#else
  vec3 base = vec3(0.0);
#endif
{
  float hh = clamp(position.y / ${H.toFixed(2)}, 0.0, 1.0); hh *= hh;
  float w = sin(uTime * 1.8 + base.x * 0.35 + base.z * 0.25) * 0.5 + sin(uTime * 3.3 + base.x * 1.7 - base.z * 1.1) * 0.18;
  mvPosition.x += w * 0.16 * hh; mvPosition.z += w * 0.06 * hh;
  for (int i = 0; i < ${MAX_GRASS_PUSHERS}; i++) {
    vec2 tp = base.xz - uPush[i].xz; float dp = length(tp);
    float push = 1.0 - smoothstep(0.15, 0.6, dp);
    mvPosition.xz += normalize(tp + 1e-4) * push * 0.3 * hh;
    mvPosition.y -= push * 0.18 * hh;
  }
}
mvPosition = modelViewMatrix * mvPosition;
gl_Position = projectionMatrix * mvPosition;`);
    };
    const COUNT = 32000, mesh = new THREE.InstancedMesh(blade, mat, COUNT);
    const dm = new THREE.Object3D(), c = new THREE.Color();
    let i = 0, guard = 0;
    while (i < COUNT && guard++ < COUNT * 4) {
      const x = rr(-30, 30), z = rr(-30, 32);
      if (onPath(x, z) || (Math.abs(x) < 3.4 && z < -11.8 && z > -17.2) || Math.hypot(x, z) > 32) continue;
      if (fbm2(x * 0.2, z * 0.2) < 0.32 && rng.next() < 0.7) continue;
      dm.position.set(x, groundHeight(x, z), z); dm.rotation.set(rr(-0.15, 0.15), rr(0, Math.PI), rr(-0.25, 0.25));
      dm.scale.setScalar(rr(0.55, 1.35)); dm.updateMatrix(); mesh.setMatrixAt(i, dm.matrix);
      c.setHSL(rr(0.22, 0.32), rr(0.25, 0.45), rr(0.8, 1.15) * 0.5); mesh.setColorAt(i, c.multiplyScalar(1.45));
      i++;
    }
    mesh.count = i; mesh.receiveShadow = true; scene.add(mesh);
  }

  // ------------------------------------------------------------------ materials
  const stoneMats = [0x9a97a0, 0x86868e, 0xa7a19a, 0x7d8285].map((col) => new THREE.MeshStandardMaterial({ color: col, map: stoneTex, roughness: 0.95 }));
  const pick = <T,>(arr: T[]) => arr[(rng.next() * arr.length) | 0];
  const ironMat = new THREE.MeshStandardMaterial({ color: 0x1b1a22, roughness: 0.55, metalness: 0.7 });
  const barkMat = new THREE.MeshStandardMaterial({ color: 0x2e2630, roughness: 1 });
  const engraved = [textTex(['R.I.P.']), textTex(['REST', 'IN PEACE']), textTex(['HERE LIES', 'A GOOD OWL'])];

  // ------------------------------------------------------------------ scenery gravestones
  const archGeo = (w: number, h: number, d: number) => {
    const s = new THREE.Shape(); s.moveTo(-w / 2, 0); s.lineTo(w / 2, 0); s.lineTo(w / 2, h - w / 2);
    s.absarc(0, h - w / 2, w / 2, 0, Math.PI, false); s.lineTo(-w / 2, 0);
    const g = new THREE.ExtrudeGeometry(s, { depth: d, bevelEnabled: true, bevelThickness: 0.025, bevelSize: 0.025, bevelSegments: 2, curveSegments: 20 });
    g.translate(0, 0, -d / 2); return g;
  };
  const gravestone = (type: string) => {
    const g = new THREE.Group(), mat = pick(stoneMats);
    let geo: THREE.BufferGeometry, plate: [number, number, number] | null = null;
    if (type === 'arch') { const w = rr(0.5, 0.7), h = rr(0.75, 1.05); geo = archGeo(w, h, 0.13); plate = [w * 0.7, h * 0.55, 0.09]; }
    else if (type === 'slab') {
      const w = rr(0.55, 0.75), h = rr(0.6, 0.85); const top = new THREE.BoxGeometry(w, h, 0.16); top.translate(0, h / 2, 0);
      const cap = new THREE.BoxGeometry(w + 0.08, 0.07, 0.22); cap.translate(0, h, 0);
      geo = merge([top, cap]); plate = [w * 0.75, h * 0.55, 0.085];
    } else if (type === 'cross') {
      const a = new THREE.BoxGeometry(0.13, 1.2, 0.12); a.translate(0, 0.6, 0);
      const b = new THREE.BoxGeometry(0.62, 0.13, 0.12); b.translate(0, 0.86, 0);
      const base = new THREE.BoxGeometry(0.36, 0.16, 0.3); base.translate(0, 0.08, 0);
      geo = merge([a, b, base]);
    } else {
      const base = new THREE.BoxGeometry(0.5, 0.22, 0.5); base.translate(0, 0.11, 0);
      const shaft = new THREE.CylinderGeometry(0.12, 0.19, 1.45, 4, 1); shaft.rotateY(Math.PI / 4); shaft.translate(0, 0.22 + 0.725, 0);
      const tip = new THREE.ConeGeometry(0.17, 0.26, 4); tip.rotateY(Math.PI / 4); tip.translate(0, 0.22 + 1.45 + 0.13, 0);
      geo = merge([base, shaft, tip]);
    }
    const m = new THREE.Mesh(geo, mat); m.castShadow = m.receiveShadow = true; g.add(m);
    if (plate && rng.next() < 0.8) {
      const p = new THREE.Mesh(new THREE.PlaneGeometry(plate[0], plate[0] * 0.5),
        new THREE.MeshStandardMaterial({ map: pick(engraved), transparent: true, roughness: 1, polygonOffset: true, polygonOffsetFactor: -2 }));
      p.position.set(0, plate[1], plate[2]); g.add(p);
    }
    return g;
  };
  const candles: THREE.Mesh[] = [];
  const candleMat = new THREE.MeshStandardMaterial({ color: 0xe8e0cc, roughness: 0.8 });
  const flameMat = new THREE.MeshBasicMaterial({ color: 0xffc46b, toneMapped: false });
  const addCandle = (x: number, y: number, z: number) => {
    const c = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.035, 0.16, 10), candleMat); c.position.set(x, y + 0.08, z);
    const f = new THREE.Mesh(new THREE.SphereGeometry(0.022, 10, 8), flameMat); f.scale.y = 1.7; f.position.set(x, y + 0.2, z);
    scene.add(c, f); candles.push(f);
  };
  const TREE_SPOTS: [number, number][] = [[-9, -5], [10.5, 1.5], [-13, 9], [13, -9.5], [7, 12.5], [-5.5, -10.5]];
  for (let z = -9; z <= 15; z += 3.1) {
    for (let x = -15.6; x <= 15.6; x += 2.25) {
      if (Math.abs(x) < 2.6 || rng.next() < 0.22) continue;
      const gx = x + rr(-0.35, 0.35), gz = z + rr(-0.3, 0.3);
      if (TREE_SPOTS.some(([tx, tz]) => Math.hypot(tx - gx, tz - gz) < 1.9)) continue;
      if (Math.hypot(gx, gz - 12) < 3) continue;
      const r = rng.next(), type = r < 0.45 ? 'arch' : r < 0.7 ? 'slab' : r < 0.9 ? 'cross' : 'obelisk';
      const s = gravestone(type);
      s.position.set(gx, -rr(0, 0.06), gz);
      s.rotation.set(rr(-0.07, 0.07), rr(-0.18, 0.18), rr(-0.08, 0.08));
      scene.add(s);
      colliders.circles.push({ x: gx, z: gz, r: type === 'obelisk' ? 0.42 : 0.4 });
      if (rng.next() < 0.45) {
        const ledger = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.12, 1.3), pick(stoneMats));
        ledger.position.set(gx, 0.04, gz + 0.85); ledger.rotation.y = s.rotation.y;
        ledger.castShadow = ledger.receiveShadow = true; scene.add(ledger);
      }
      if (rng.next() < 0.12) addCandle(gx + rr(-0.25, 0.25), 0, gz + 0.32);
    }
  }

  // ------------------------------------------------------------------ dead trees
  const UP = new THREE.Vector3(0, 1, 0);
  const treeGeo = (sc: number) => {
    const geos: THREE.BufferGeometry[] = [];
    const br = (start: THREE.Vector3, dir: THREE.Vector3, len: number, rad: number, depth: number) => {
      const g = new THREE.CylinderGeometry(rad * 0.66, rad, len, 7, 1); g.translate(0, len / 2, 0);
      g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, dir)); g.translate(start.x, start.y, start.z); geos.push(g);
      if (depth <= 0) return;
      const end = start.clone().addScaledVector(dir, len);
      const n = depth > 2 ? 2 + (rng.next() < 0.45 ? 1 : 0) : 2;
      for (let k = 0; k < n; k++) {
        const d = dir.clone().applyAxisAngle(new THREE.Vector3(rr(-1, 1), 0, rr(-1, 1)).normalize(), rr(0.35, 0.9));
        d.y = Math.max(d.y, -0.15) + 0.06; d.normalize();
        br(end, d, len * rr(0.6, 0.8), rad * 0.64, depth - 1);
      }
    };
    br(new THREE.Vector3(), new THREE.Vector3(rr(-0.12, 0.12), 1, rr(-0.12, 0.12)).normalize(), 1.7 * sc, 0.2 * sc, 5);
    const root = new THREE.CylinderGeometry(0.2 * sc, 0.38 * sc, 0.35, 8); root.translate(0, 0.17, 0); geos.push(root);
    return merge(geos);
  };
  const treeGeos = [treeGeo(1), treeGeo(1.15), treeGeo(0.9), treeGeo(1.3)];
  const addTree = (x: number, z: number, collide: boolean) => {
    const t = new THREE.Mesh(pick(treeGeos), barkMat);
    t.position.set(x, groundHeight(x, z) - 0.05, z); t.rotation.y = rr(0, 6.28); t.scale.setScalar(rr(0.9, 1.3));
    t.castShadow = true; t.receiveShadow = true; scene.add(t);
    if (collide) colliders.circles.push({ x, z, r: 0.45 });
  };
  TREE_SPOTS.forEach(([x, z]) => addTree(x, z, true));
  for (let i = 0; i < 26; i++) { const a = rr(0, 6.28), r = rr(23, 48); addTree(Math.cos(a) * r, Math.sin(a) * r, r < 34); }

  // ------------------------------------------------------------------ iron fence with a gate
  {
    const bars: [number, number][] = [], posts: [number, number][] = [];
    const side = (x0: number, z0: number, x1: number, z1: number) => {
      const len = Math.hypot(x1 - x0, z1 - z0), n = Math.round(len / 0.2);
      for (let i = 0; i <= n; i++) bars.push([lerp(x0, x1, i / n), lerp(z0, z1, i / n)]);
      const pn = Math.round(len / 4);
      for (let i = 0; i <= pn; i++) posts.push([lerp(x0, x1, i / pn), lerp(z0, z1, i / pn)]);
      for (const y of [0.22, 1.12]) {
        const r = new THREE.Mesh(new THREE.BoxGeometry(len, 0.035, 0.035), ironMat);
        r.position.set((x0 + x1) / 2, y, (z0 + z1) / 2); r.rotation.y = -Math.atan2(z1 - z0, x1 - x0); r.castShadow = true; scene.add(r);
      }
      colliders.segs.push([x0, z0, x1, z1]);
    };
    side(-HALF, -HALF, HALF, -HALF); side(HALF, -HALF, HALF, HALF); side(-HALF, HALF, -HALF, -HALF);
    side(HALF, HALF, GATE + 0.3, HALF); side(-GATE - 0.3, HALF, -HALF, HALF);
    const barGeo = new THREE.CylinderGeometry(0.016, 0.016, 1.3, 6); barGeo.translate(0, 0.65, 0);
    const tipGeo = new THREE.ConeGeometry(0.04, 0.13, 6); tipGeo.translate(0, 1.36, 0);
    const im = new THREE.InstancedMesh(merge([barGeo, tipGeo]), ironMat, bars.length), dm = new THREE.Object3D();
    bars.forEach(([x, z], i) => { dm.position.set(x, 0, z); dm.updateMatrix(); im.setMatrixAt(i, dm.matrix); });
    im.castShadow = true; scene.add(im);
    const postBox = new THREE.BoxGeometry(0.11, 1.5, 0.11); postBox.translate(0, 0.75, 0);
    const postBall = new THREE.SphereGeometry(0.075, 12, 8); postBall.translate(0, 1.58, 0);
    const pm = new THREE.InstancedMesh(merge([postBox, postBall]), ironMat, posts.length);
    posts.forEach(([x, z], i) => { dm.position.set(x, 0, z); dm.updateMatrix(); pm.setMatrixAt(i, dm.matrix); });
    pm.castShadow = true; scene.add(pm);
    for (const s of [-1, 1]) {
      const x = s * (GATE + 0.3);
      const p = new THREE.Mesh(new THREE.BoxGeometry(0.55, 2.3, 0.55), stoneMats[0]); p.position.set(x, 1.15, HALF);
      const cap = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.14, 0.7), stoneMats[0]); cap.position.set(x, 2.37, HALF);
      const ball = new THREE.Mesh(new THREE.SphereGeometry(0.2, 18, 14), stoneMats[0]); ball.position.set(x, 2.6, HALF);
      for (const m of [p, cap, ball]) { m.castShadow = m.receiveShadow = true; scene.add(m); }
      colliders.circles.push({ x, z: HALF, r: 0.42 });
    }
    const arch = new THREE.Mesh(new THREE.TorusGeometry(GATE + 0.3, 0.035, 8, 48, Math.PI), ironMat);
    arch.position.set(0, 2.3, HALF); arch.scale.y = 0.45; scene.add(arch);
  }

  // ------------------------------------------------------------------ the crypt
  {
    const S = stoneMats[2], D = stoneMats[3];
    const box = (w: number, h: number, d: number, x: number, y: number, z: number, m: THREE.Material = S) => {
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); b.position.set(x, y, z); b.castShadow = b.receiveShadow = true; scene.add(b); return b;
    };
    box(6.4, 0.3, 5.0, 0, 0.15, -14.5, D);
    box(2.8, 0.15, 0.6, 0, 0.075, -11.75, D);
    box(5.0, 3.2, 3.6, 0, 1.9, -15.0);
    box(5.5, 0.36, 4.7, 0, 3.68, -14.6, D);
    for (const x of [-2.2, -0.95, 0.95, 2.2]) {
      const c = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.2, 3.2, 16), S); c.position.set(x, 1.9, -12.75); c.castShadow = c.receiveShadow = true; scene.add(c);
      box(0.5, 0.14, 0.5, x, 0.37, -12.75, D);
    }
    const tri = new THREE.Shape(); tri.moveTo(-2.85, 0); tri.lineTo(2.85, 0); tri.lineTo(0, 1.15); tri.lineTo(-2.85, 0);
    const ped = new THREE.Mesh(new THREE.ExtrudeGeometry(tri, { depth: 4.7, bevelEnabled: false }), D);
    ped.position.set(0, 3.86, -16.95); ped.castShadow = ped.receiveShadow = true; scene.add(ped);
    box(1.3, 2.3, 0.12, 0, 1.45, -13.17, new THREE.MeshStandardMaterial({ color: 0x241b1e, roughness: 0.9 }));
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(0.08, 2.2), new THREE.MeshBasicMaterial({ color: 0xffb066, toneMapped: false }));
    glow.position.set(0.66, 1.45, -13.1); scene.add(glow);
    const plaque = new THREE.Mesh(new THREE.PlaneGeometry(3.0, 0.3), new THREE.MeshStandardMaterial({ map: textTex(['REQUIESCAT'], 512, 52), transparent: true, polygonOffset: true, polygonOffsetFactor: -2 }));
    plaque.position.set(0, 3.68, -12.24); scene.add(plaque);
    addCandle(-1.1, 0.15, -11.75); addCandle(1.15, 0.15, -11.7); addCandle(0.8, 0.15, -11.85);
    addBox(-3.2, -17.0, 3.2, -12.0);
  }

  // ------------------------------------------------------------------ lanterns (the only point lights)
  const lanterns: { light: THREE.PointLight; flame: THREE.Mesh; base: number; ph: number }[] = [];
  const cageMat = new THREE.MeshStandardMaterial({ color: 0x1b1a22, roughness: 0.6, metalness: 0.6, wireframe: true });
  const lanternFlame = new THREE.MeshBasicMaterial({ color: 0xffb35a, toneMapped: false });
  const addLantern = (x: number, z: number, h = 1.7) => {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.06, h, 8), ironMat); post.position.set(x, h / 2, z); post.castShadow = true;
    const cage = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.3, 0.24), cageMat); cage.position.set(x, h + 0.15, z);
    const roof = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.16, 4), ironMat); roof.rotation.y = Math.PI / 4; roof.position.set(x, h + 0.38, z);
    const flame = new THREE.Mesh(new THREE.SphereGeometry(0.08, 14, 10), lanternFlame); flame.position.set(x, h + 0.14, z);
    const light = new THREE.PointLight(0xffa04a, 9, 11, 2); light.position.set(x, h + 0.15, z);
    scene.add(post, cage, roof, flame, light);
    lanterns.push({ light, flame, base: 9, ph: rng.next() * 100 });
    colliders.circles.push({ x, z, r: 0.18 });
  };
  addLantern(-1.75, 13.2); addLantern(1.75, 4.5); addLantern(-1.75, -4.5); addLantern(1.8, -11.4, 1.4); addLantern(0, 21.5, 2.2);

  // ------------------------------------------------------------------ fireflies
  {
    const N = 140, pos = new Float32Array(N * 3), sd = new Float32Array(N);
    for (let i = 0; i < N; i++) { pos[i * 3] = rr(-24, 24); pos[i * 3 + 1] = rr(0.3, 2.6); pos[i * 3 + 2] = rr(-22, 26); sd[i] = rng.next(); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('aSeed', new THREE.BufferAttribute(sd, 1));
    const m = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uTime: time, uPR: { value: renderer.getPixelRatio() } },
      vertexShader: `attribute float aSeed; uniform float uTime; uniform float uPR; varying float vA;
        void main(){ vec3 p = position; float t = uTime * 0.45 + aSeed * 20.;
          p.x += sin(t * 0.9 + aSeed * 6.) * 0.9; p.y += sin(t * 1.3 + aSeed * 3.) * 0.35; p.z += cos(t * 0.7 + aSeed * 9.) * 0.9;
          vec4 mv = modelViewMatrix * vec4(p, 1.); gl_Position = projectionMatrix * mv;
          vA = 0.25 + 0.75 * pow(0.5 + 0.5 * sin(uTime * 2.2 + aSeed * 40.), 3.);
          gl_PointSize = 55.0 * uPR / -mv.z; }`,
      fragmentShader: `varying float vA; void main(){ float d = length(gl_PointCoord - .5); float a = smoothstep(.5, 0., d); a *= a;
          gl_FragColor = vec4(vec3(1., .88, .45) * a * vA * 1.6, a * vA); }`,
    });
    const pts = new THREE.Points(g, m); pts.frustumCulled = false; scene.add(pts);
  }

  return {
    scene, colliders, groundHeight,
    update(t, camera, focus) {
      time.value = t;
      sky.position.copy(camera.position);
      moon.position.copy(camera.position).addScaledVector(MOON_DIR, 300); moon.lookAt(camera.position);
      moonGlow.position.copy(moon.position);
      moonLight.position.copy(focus).add(LIGHT_OFF); moonLight.target.position.copy(focus);
      for (const l of lanterns) {
        const f = 0.82 + 0.1 * Math.sin(t * 9 + l.ph) + 0.08 * Math.sin(t * 23.7 + l.ph * 2);
        l.light.intensity = l.base * f; l.flame.scale.setScalar(0.9 + f * 0.15);
      }
      candles.forEach((c, i) => c.scale.set(1, 1.6 + 0.3 * Math.sin(t * 13 + i * 7), 1));
    },
    setShadows(on) {
      renderer.shadowMap.enabled = on;
      moonLight.castShadow = on;
      scene.traverse((o) => { const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined; if (m) (Array.isArray(m) ? m : [m]).forEach((x) => (x.needsUpdate = true)); });
    },
    setGrassPushers(points) {
      for (let i = 0; i < MAX_GRASS_PUSHERS; i++) {
        const p = points[i];
        if (p) pushers[i].set(p.x, 0, p.z); else pushers[i].set(9999, 0, 9999);
      }
    },
  };
}
