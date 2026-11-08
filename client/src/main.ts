import './style.css';
import * as THREE from 'three';
import { EMOTE_COUNT, STATE_SEND_HZ, type PlayerState, type ServerMessage } from '../../shared/protocol.ts';
import { createWorld } from './world/world.ts';
import { getOwlTemplate } from './owl/model.ts';
import { createOwl } from './owl/owl.ts';
import { LocalPlayer } from './game/player.ts';
import { CameraRig } from './game/camera.ts';
import { Input } from './game/input.ts';
import { Connection } from './net/connection.ts';
import { RemotePlayers } from './net/remotes.ts';
import { Hud } from './ui/hud.ts';
import { ChatPanel } from './ui/chat.ts';
import { NameTag } from './ui/nametag.ts';
import { Landing } from './ui/landing.ts';
import { GraveField, type PlotFocus } from './world/graves.ts';
import { PlotCard } from './ui/plotcard.ts';
import { CreateGraveDialog } from './ui/creategrave.ts';
import { OfferingDialog } from './ui/offering.ts';
import { pendingPayment } from './ui/payflow.ts';
import { itemName, levelName } from '../../shared/graves.ts';
import { Wallet } from './wallet/wallet.ts';
import { api, ApiError } from './net/api.ts';
import { shortAccount } from './ui/dom.ts';
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
  // fixed low resolution (1 render pixel per CSS pixel): keeps the game smooth on every machine
  const fitCanvas = () => { renderer.setPixelRatio(1); renderer.setSize(innerWidth, innerHeight, false); };
  fitCanvas();
  renderer.shadowMap.enabled = prefs.shadows();
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;

  const input = new Input();
  input.enabled = false;   // until the player enters from the intro screen
  let conn: Connection | null = null;
  const hud = new Hud({
    retry: () => conn?.retryNow(),
    rename: (name) => conn?.send({ t: 'rename', name }) ?? false,
    setShadows: (on) => { prefs.setShadows(on); world.setShadows(on); },
  });
  const chat = new ChatPanel((text) => conn?.send({ t: 'chat', text }) ?? false);

  // ---- build the world and the owl (heavy: give the loading text a chance to paint first)
  await nextFrame();
  const world = createWorld(renderer);
  world.setShadows(prefs.shadows());
  await nextFrame();
  getOwlTemplate();
  const owl = createOwl();
  const player = new LocalPlayer(owl);
  world.scene.add(owl.root, owl.blob);
  const selfTag = new NameTag('', true);
  selfTag.sprite.visible = false;
  world.scene.add(selfTag.sprite);
  const cam = new CameraRig(canvas);

  // ---- graves (loaded from the server; visible behind the intro too)
  const graves = new GraveField(world.scene, world.colliders, world.materials.stone, world.materials.iron);
  const loadGraves = () => api.graves().then((g) => { graves.setGraves(g.graves); graves.setReserved(g.reserved); }).catch((e) => console.warn('graves', e));
  void loadGraves();

  // ---- wallet (top right), graves and offerings
  const wallet = new Wallet();
  const walletBtn = document.getElementById('wallet-btn') as HTMLButtonElement;
  const walletMenu = document.getElementById('wallet-menu') as HTMLElement;
  const showWallet = (a: string | null) => {
    document.getElementById('wallet-label')!.textContent = a ? shortAccount(a) : 'Connect wallet';
    document.getElementById('wallet-account')!.textContent = a ?? '';
    if (!a) { walletMenu.hidden = true; walletBtn.setAttribute('aria-expanded', 'false'); }
  };
  wallet.onChange(showWallet);
  walletBtn.addEventListener('click', async () => {
    if (!wallet.account) {
      walletBtn.disabled = true;
      try { await wallet.connect(); } catch (e) { console.error('wallet connect failed', e); hud.toast('Could not open the wallet. Try again.'); } finally { walletBtn.disabled = false; }
      return;
    }
    walletMenu.hidden = !walletMenu.hidden;
    walletBtn.setAttribute('aria-expanded', String(!walletMenu.hidden));
  });
  document.getElementById('wallet-disconnect')!.addEventListener('click', () => void wallet.disconnect());
  document.addEventListener('click', (e) => { if (!walletMenu.hidden && !(e.target as HTMLElement).closest('.wallet-wrap')) walletMenu.hidden = true; });
  void wallet.restore();
  const createGrave = new CreateGraveDialog(wallet, (t) => hud.toast(t));
  const offering = new OfferingDialog(wallet, (t) => hud.toast(t));
  const plotCard = new PlotCard(wallet, (plot) => void createGrave.open(plot), (g) => void offering.open(graves.grave(g.id) ?? g));
  let focus: PlotFocus | null = null;
  const remotes = new RemotePlayers(world.scene);
  input.bindTouchButtons(document);

  // ---- emotes (buttons + keys 1-5) and snapshot (button + P)
  const emoteButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-emote]')];
  for (const b of emoteButtons) b.addEventListener('click', () => { player.toggleEmote(Number(b.dataset.emote)); b.blur(); });
  for (let i = 1; i <= EMOTE_COUNT; i++) input.onPress(`Digit${i}`, () => player.toggleEmote(i));
  let shownEmote = -1;
  const syncEmoteButtons = () => {
    if (player.emote === shownEmote) return;
    shownEmote = player.emote;
    for (const b of emoteButtons) b.setAttribute('aria-pressed', String(Number(b.dataset.emote) === player.emote));
  };
  const snapshot = () => {
    // render and read back in the same task, while the frame is still in the drawing buffer
    renderer.render(world.scene, cam.camera);
    canvas.toBlob((blob) => {
      if (!blob) { hud.toast('Could not save the snapshot.'); return; }
      const d = new Date(), pad = (n: number) => String(n).padStart(2, '0');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `rest-in-pump-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      hud.toast('Snapshot saved.');
    }, 'image/png');
  };
  document.getElementById('snap-btn')!.addEventListener('click', (e) => { snapshot(); (e.currentTarget as HTMLElement).blur(); });
  input.onPress('KeyP', snapshot);
  input.onPress('Enter', () => chat.focus());
  input.onPress('KeyE', () => plotCard.press(focus));

  // ---- multiplayer
  let selfId: string | null = null;
  let myName = '';
  let joinedOnce = false;
  conn = new Connection(() => ({ name: prefs.name(), resume: sessionState.token(), room: null }));
  const c = conn;
  c.onStatus((s) => {
    hud.setStatus(s);
    chat.setConnected(s.kind === 'connected');
    plotCard.canAct = s.kind === 'connected';
    if (s.kind === 'outdated' || s.kind === 'refused') remotes.clear();
  });
  c.onMessage((m: ServerMessage) => {
    switch (m.t) {
      case 'welcome': {
        selfId = m.you;
        sessionState.setToken(m.session);
        remotes.reset(m.players, m.you);
        const self = m.players.find((p) => p.id === m.you);
        if (self) {
          myName = self.name;
          hud.setMyName(self.name);
          selfTag.setName(self.name);
          selfTag.sprite.visible = true;
          owl.setWalk(self.state.walk);   // the server picks our walk style; it never changes
          const far = Math.hypot(self.state.x - player.pos.x, self.state.z - player.pos.z) > 2;
          if (!m.resumed || far) { player.place(self.state); cam.snapTo(player.pos); }
        }
        const others = m.players.length - 1;
        if (!joinedOnce) {
          chat.system(`You joined as ${myName}. ${others === 0 ? 'Nobody else is here yet.' : `${others} other ${others === 1 ? 'owl is' : 'owls are'} here.`}`);
          chat.system('Arrow keys walk · Shift run · Space hop · 1–5 emotes · P snapshot · Enter chat');
        } else { chat.system('Reconnected.'); void loadGraves(); }
        joinedOnce = true;
        lastSent = null;
        break;
      }
      case 'player_joined':
        remotes.add(m.p);
        chat.system(`${m.p.name} joined.`);
        break;
      case 'player_left': {
        const name = remotes.name(m.id);
        remotes.remove(m.id);
        if (name) chat.system(`${name} left.`);
        break;
      }
      case 'presence': remotes.setConnected(m.id, m.connected); break;
      case 'renamed':
        if (m.id === selfId) {
          myName = m.name; prefs.setName(m.name); hud.setMyName(m.name); selfTag.setName(m.name); hud.nameResult(true, 'Saved.');
        } else {
          const old = remotes.name(m.id);
          remotes.rename(m.id, m.name);
          if (old) chat.system(`${old} is now ${m.name}.`);
        }
        break;
      case 'chat':
        if (m.id === selfId) { selfTag.say(m.text); chat.message(m.name, m.text, true); }
        else { remotes.say(m.id, m.text); chat.message(m.name, m.text, false); }
        break;
      case 'grave_added':
        graves.addGrave(m.grave);
        chat.system(`${shortAccount(m.grave.creator)} created a grave for $${m.grave.meme.symbol} at plot #${m.grave.plot}.`);
        break;
      case 'grave_updated':
        graves.addGrave(m.grave);
        offering.graveUpdated(m.grave);
        plotCard.invalidate(m.grave.id);
        chat.system(`${shortAccount(m.offering.payer)} left ${itemName(m.offering.item).toLowerCase()} at $${m.grave.meme.symbol}.`);
        if (m.offering.levelUp) chat.system(`$${m.grave.meme.symbol} is now a Level ${m.grave.level} ${levelName(m.grave.level)}.`);
        break;
      case 'plots_reserved': graves.setReserved(m.reserved); break;
      case 'snapshot': remotes.applySnapshot(m.ts, m.s); break;
      case 'online': hud.setOnline(m.total); break;
      case 'rooms': break;
      case 'error':
        if (m.fatal) break;   // the connection handles fatal errors
        if (m.code === 'bad_name') hud.nameResult(false, m.message);
        else if (m.code === 'bad_chat' || m.code === 'chat_too_fast') chat.error(m.message);
        else console.warn('[server]', m.code, m.message);
        break;
      case 'pong': break;
    }
  });

  // ---- send our state ~15 times a second, only when something changed (plus a 1 s keep-alive)
  let lastSent: { s: PlayerState; at: number } | null = null;
  setInterval(() => {
    if (!c.connected) return;
    const s = player.state(), now = performance.now();
    const changed = !lastSent || Math.abs(s.x - lastSent.s.x) > 0.005 || Math.abs(s.z - lastSent.s.z) > 0.005 || Math.abs(s.y - lastSent.s.y) > 0.005 ||
      Math.abs(s.yaw - lastSent.s.yaw) > 0.01 || Math.abs(s.speed - lastSent.s.speed) > 0.05 || s.air !== lastSent.s.air || s.emote !== lastSent.s.emote;
    if (!changed && lastSent && now - lastSent.at < 1000) return;
    if (c.send({ t: 'state', s })) lastSent = { s, at: now };
  }, Math.round(1000 / STATE_SEND_HZ));

  // ---- the intro screen: the world plays behind it; Enter joins the multiplayer world
  let entered = false;
  const enterWorld = () => {
    entered = true;
    input.enabled = true;
    cam.follow();
    canvas.focus();
    c.start();
    // finish a payment (grave or offering) interrupted by a refresh or a wallet redirect
    const q = new URLSearchParams(location.search);
    const hash = q.get('transactionHashes')?.split(',').pop() ?? null;
    if (q.has('transactionHashes') || q.has('errorCode') || q.has('account_id')) history.replaceState(null, '', location.pathname);
    void recoverPayment(hash ? { hash, account: q.get('account_id') } : null);
  };
  const recoverPayment = async (redirectTx: { hash: string; account: string | null } | null) => {
    const id = pendingPayment.get();
    if (!id) return;
    let p;
    try { p = await api.payment(id); } catch (e) {
      if (e instanceof ApiError && e.status === 404) pendingPayment.clear();
      return;
    }
    if (p.status === 'fulfilled') {
      pendingPayment.clear();
      hud.toast(p.kind === 'grave' ? `Your $${p.meme.symbol} grave at plot #${p.plot} is ready.` : `Your offering at $${p.meme.symbol} was received.`);
      return;
    }
    if (p.status === 'failed' || p.status === 'expired') { pendingPayment.clear(); return; }
    if (p.status === 'confirming') hud.toast('Still confirming your payment on NEAR…');
    if (p.kind === 'grave') await createGrave.resume(p, redirectTx);
    else await offering.resume(p, redirectTx);
  };
  const landing = new Landing(enterWorld);

  // ---- render loop
  let last = performance.now(), t = 0;
  const pushers: THREE.Vector3[] = [];
  const frame = () => {
    const now = performance.now();
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now; t += dt;
    player.update(dt, t, input, cam.yaw, world.colliders);   // input is ignored until entered
    syncEmoteButtons();
    selfTag.sprite.position.set(player.pos.x, player.height + 1.0, player.pos.z);
    selfTag.tick(now);
    remotes.update(dt, t);
    focus = entered ? graves.focusAt(player.pos) : null;
    graves.update(t, focus);
    plotCard.show(focus);
    if (entered) cam.update(dt, input, player.pos, player.height, world.groundHeight);
    else cam.cinematic(t, world.groundHeight);
    pushers.length = 0; pushers.push(player.pos); remotes.positions(pushers);
    world.setGrassPushers(pushers);
    world.update(t, cam.camera, player.pos);
    renderer.render(world.scene, cam.camera);
    requestAnimationFrame(frame);
  };
  addEventListener('resize', () => { cam.resize(); fitCanvas(); });
  requestAnimationFrame(frame);
  await nextFrame();
  // every page load starts at the intro (so "What is Rest In Pump?" is always reachable); Enter resumes the same player within the grace period
  landing.show();

  if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__rip = { player, remotes, conn: c, owl, graves, cam };
}

main().catch((err) => {
  console.error(err);
  const el = document.getElementById('fatal');
  if (el) { el.textContent = 'Something went wrong while loading the game. Please reload the page.'; el.hidden = false; }
});
