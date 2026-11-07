import './style.css';
import * as THREE from 'three';
import { STATE_SEND_HZ, type PlayerState, type ServerMessage } from '../../shared/protocol.ts';
import { createWorld } from './world/world.ts';
import { getOwlTemplate } from './owl/model.ts';
import { createOwl, WALKS } from './owl/owl.ts';
import { LocalPlayer } from './game/player.ts';
import { CameraRig } from './game/camera.ts';
import { Input } from './game/input.ts';
import { Connection } from './net/connection.ts';
import { RemotePlayers } from './net/remotes.ts';
import { Hud } from './ui/hud.ts';
import { prefs, sessionState } from './util/storage.ts';

/** Yields so the loading text can paint. Background tabs get no animation frames, so don't wait for one there. */
const nextFrame = () => new Promise<void>((r) => (document.hidden ? setTimeout(r, 0) : requestAnimationFrame(() => setTimeout(r, 0))));

async function main() {
  const canvas = document.getElementById('game') as HTMLCanvasElement;
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  } catch {
    document.getElementById('fatal')!.textContent =
      'Your browser could not start 3D graphics (WebGL). Try another browser, or turn on hardware acceleration.';
    document.getElementById('fatal')!.hidden = false;
    return;
  }
  const applyResolution = (v: string) => {
    const cap = v === 'low' ? 1 : v === 'balanced' ? 1.25 : 2;
    renderer.setPixelRatio(Math.min(devicePixelRatio, cap));
    renderer.setSize(innerWidth, innerHeight, false);
  };
  applyResolution(prefs.resolution());
  renderer.shadowMap.enabled = prefs.shadows();
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;

  const input = new Input();
  let me: LocalPlayer | null = null;
  let conn: Connection | null = null;
  const hud = new Hud({
    retry: () => conn?.retryNow(),
    rename: (name) => conn?.send({ t: 'rename', name }) ?? false,
    nextWalk: () => me?.owl.setWalk(me.owl.walk + 1),
    setShadows: (on) => { prefs.setShadows(on); world.setShadows(on); },
    setResolution: (v) => { prefs.setResolution(v); applyResolution(v); },
  });

  // ---- build the world and the owl (heavy: give the loading text a chance to paint first)
  hud.setLoading('Building the graveyard…');
  await nextFrame();
  const world = createWorld(renderer);
  world.setShadows(prefs.shadows());
  hud.setLoading('Waking up the owls…');
  await nextFrame();
  getOwlTemplate();
  const owl = createOwl({ autoWalk: true, onWalkChange: (i) => hud.setWalk(WALKS[i].name) });
  hud.setWalk(WALKS[owl.walk].name);
  const player = new LocalPlayer(owl);
  me = player;
  world.scene.add(owl.root, owl.blob);
  const cam = new CameraRig(canvas);
  const remotes = new RemotePlayers(world.scene);
  input.onPress('KeyF', () => owl.setWalk(owl.walk + 1));
  input.bindTouchButtons(document);

  // ---- multiplayer
  let selfId: string | null = null;
  conn = new Connection(() => ({ name: prefs.name(), resume: sessionState.token(), room: null }));
  const c = conn;
  c.onStatus((s) => hud.setStatus(s));
  c.onMessage((m: ServerMessage) => {
    switch (m.t) {
      case 'welcome': {
        selfId = m.you;
        sessionState.setToken(m.session);
        remotes.reset(m.players, m.you);
        const self = m.players.find((p) => p.id === m.you);
        if (self) {
          hud.setMyName(self.name);
          const far = Math.hypot(self.state.x - player.pos.x, self.state.z - player.pos.z) > 2;
          if (!m.resumed || far) { player.place(self.state); cam.snapTo(player.pos); }
        }
        lastSent = null;
        break;
      }
      case 'player_joined': remotes.add(m.p); break;
      case 'player_left': remotes.remove(m.id); break;
      case 'presence': remotes.setConnected(m.id, m.connected); break;
      case 'renamed':
        if (m.id === selfId) { prefs.setName(m.name); hud.setMyName(m.name); hud.nameResult(true, 'Saved.'); }
        else remotes.rename(m.id, m.name);
        break;
      case 'snapshot': remotes.applySnapshot(m.ts, m.s); break;
      case 'online': hud.setOnline(m.total); break;
      case 'rooms': break;
      case 'error':
        if (m.fatal) break;   // the connection handles fatal errors
        if (m.code === 'bad_name') hud.nameResult(false, m.message);
        else console.warn('[server]', m.code, m.message);
        break;
      case 'pong': break;
    }
  });
  c.onStatus((s) => { if (s.kind === 'outdated' || s.kind === 'refused') remotes.clear(); });
  c.start();

  // ---- send our state ~15 times a second, only when something changed (plus a 1 s keep-alive)
  let lastSent: { s: PlayerState; at: number } | null = null;
  setInterval(() => {
    if (!c.connected) return;
    const s = player.state(), now = performance.now();
    const changed = !lastSent || Math.abs(s.x - lastSent.s.x) > 0.005 || Math.abs(s.z - lastSent.s.z) > 0.005 || Math.abs(s.y - lastSent.s.y) > 0.005 ||
      Math.abs(s.yaw - lastSent.s.yaw) > 0.01 || Math.abs(s.speed - lastSent.s.speed) > 0.05 || s.air !== lastSent.s.air || s.walk !== lastSent.s.walk;
    if (!changed && lastSent && now - lastSent.at < 1000) return;
    if (c.send({ t: 'state', s })) lastSent = { s, at: now };
  }, Math.round(1000 / STATE_SEND_HZ));

  // ---- render loop
  let last = performance.now(), t = 0, movedFor = 0;
  const pushers: THREE.Vector3[] = [];
  const frame = () => {
    const now = performance.now();
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now; t += dt;
    player.update(dt, t, input, cam.yaw, world.colliders);
    remotes.update(dt, t);
    cam.update(dt, input, player.pos, player.height, world.groundHeight);
    pushers.length = 0; pushers.push(player.pos); remotes.positions(pushers);
    world.setGrassPushers(pushers);
    world.update(t, cam.camera, player.pos);
    renderer.render(world.scene, cam.camera);
    if (player.speed > 0.5 && (movedFor += dt) > 10 && !prefs.seenControls()) hud.dismissHint();
    requestAnimationFrame(frame);
  };
  addEventListener('resize', () => { cam.resize(); applyResolution(prefs.resolution()); });
  requestAnimationFrame(frame);
  await nextFrame();
  hud.setLoading(null);

  if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__rip = { player, remotes, conn: c, owl };
}

main().catch((err) => {
  console.error(err);
  const el = document.getElementById('fatal');
  if (el) { el.textContent = 'Something went wrong while loading the game. Please reload the page.'; el.hidden = false; }
});
