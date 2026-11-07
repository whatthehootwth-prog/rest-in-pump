import { roomLabel, sanitizeName, type RoomSummary } from '../../../shared/protocol.ts';
import type { NetStatus } from '../net/connection.ts';
import { prefs } from '../util/storage.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing from index.html`);
  return el as T;
};

export interface HudActions {
  retry(): void;
  rename(name: string): boolean;
  listRooms(): boolean;
  joinRoom(id: string): boolean;
  nextWalk(): void;
  setShadows(on: boolean): void;
  setResolution(v: string): void;
}

/**
 * The minimal HUD. It only ever shows information that comes from the game or the server:
 * the online count is the server's count of connected players, the room list is the server's list.
 */
export class Hud {
  private readonly actions: HudActions;
  private status: NetStatus = { kind: 'connecting', attempt: 1, retrying: false };
  private currentRoom: string | null = null;
  private myName = '';
  private bannerTimer: number | null = null;
  private namePending: number | null = null;
  private roomPending: number | null = null;
  private readonly dialog = $<HTMLDialogElement>('settings');

  constructor(actions: HudActions) {
    this.actions = actions;
    $('settings-btn').addEventListener('click', () => this.openSettings());
    $('settings-close').addEventListener('click', () => this.dialog.close());
    this.dialog.addEventListener('click', (e) => { if (e.target === this.dialog) this.dialog.close(); });
    $('net-retry').addEventListener('click', () => actions.retry());
    $('net-reload').addEventListener('click', () => location.reload());
    $('walk-btn').addEventListener('click', () => actions.nextWalk());
    $('rooms-refresh').addEventListener('click', () => this.requestRooms());
    $('name-form').addEventListener('submit', (e) => { e.preventDefault(); this.submitName(); });
    $<HTMLInputElement>('name-input').addEventListener('input', () => this.validateNameField(false));

    const shadows = $<HTMLInputElement>('opt-shadows');
    shadows.checked = prefs.shadows();
    shadows.addEventListener('change', () => actions.setShadows(shadows.checked));
    const res = $<HTMLSelectElement>('opt-res');
    res.value = prefs.resolution();
    res.addEventListener('change', () => actions.setResolution(res.value));

    if (!prefs.seenControls()) {
      $('controls-hint').hidden = false;
      $('hint-close').addEventListener('click', () => this.dismissHint());
    }
    this.setStatus(this.status);
  }

  // ------------------------------------------------------------------ loading / fatal
  setLoading(text: string | null) {
    if (text === null) { $('loading').classList.add('done'); return; }
    $('loading-text').textContent = text;
  }
  fatal(message: string) {
    const el = $('fatal');
    el.textContent = message;
    el.hidden = false;
  }

  dismissHint() {
    $('controls-hint').hidden = true;
    prefs.setSeenControls();
  }

  // ------------------------------------------------------------------ connection
  setStatus(s: NetStatus) {
    const kindChanged = s.kind !== this.status.kind;
    this.status = s;
    const dot = $('net-dot'), banner = $('net-banner'), text = $('net-banner-text');
    const retry = $('net-retry'), reload = $('net-reload');
    dot.className = 'dot ' + (s.kind === 'connected' ? 'dot-ok' : s.kind === 'connecting' || s.kind === 'reconnecting' ? 'dot-wait' : 'dot-bad');
    if (this.bannerTimer !== null) { clearInterval(this.bannerTimer); this.bannerTimer = null; }
    retry.hidden = reload.hidden = true;
    banner.classList.toggle('bad', s.kind === 'offline' || s.kind === 'refused' || s.kind === 'outdated');

    const countdown = (prefix: string, at: number) => {
      const draw = () => { text.textContent = `${prefix} Retrying in ${Math.max(0, Math.ceil((at - Date.now()) / 1000))}s.`; };
      draw();
      this.bannerTimer = window.setInterval(draw, 500);
    };
    switch (s.kind) {
      case 'connected':
        banner.hidden = true;
        $('net-detail').textContent = s.rttMs === null ? 'connected' : `connected · ${s.rttMs} ms`;
        break;
      case 'connecting':
        banner.hidden = !s.retrying;   // the very first attempt is shown by the online chip only
        text.textContent = s.retrying ? 'Connection lost. Reconnecting…' : 'Connecting to the graveyard…';
        $('online-text').textContent = s.retrying ? 'Reconnecting…' : 'Connecting…';
        $('net-detail').textContent = s.retrying ? `reconnecting (attempt ${s.attempt})` : 'connecting';
        break;
      case 'reconnecting':
        banner.hidden = false; retry.hidden = false;
        countdown('Connection lost. You are still in the world while we reconnect.', s.retryAt);
        $('online-text').textContent = 'Reconnecting…';
        $('net-detail').textContent = `reconnecting (attempt ${s.attempt})`;
        break;
      case 'offline':
        banner.hidden = false; retry.hidden = false;
        countdown(navigator.onLine ? 'Can’t reach the game server.' : 'You appear to be offline.', s.retryAt);
        $('online-text').textContent = 'Offline';
        $('net-detail').textContent = `offline (attempt ${s.attempt})`;
        break;
      case 'refused':
        banner.hidden = false; retry.hidden = false;
        countdown(s.message, s.retryAt);
        $('online-text').textContent = 'Not joined';
        $('net-detail').textContent = `refused: ${s.code}`;
        break;
      case 'outdated':
        banner.hidden = false; reload.hidden = false;
        text.textContent = s.message;
        $('online-text').textContent = 'Update needed';
        $('net-detail').textContent = 'outdated client';
        break;
    }
    if (s.kind !== 'connected') { this.clearPending(); }
    // only rebuild the room buttons when connectivity changes (a rebuild would steal keyboard focus)
    if (kindChanged) this.renderRoomControls();
  }

  setOnline(total: number, inRoom: number) {
    $('online-text').textContent = `${total} online`;
    $('online').title = `${inRoom} in ${this.currentRoom ? roomLabel(this.currentRoom) : 'this graveyard'} · ${total} across all graveyards`;
  }

  setRoom(room: RoomSummary) {
    this.currentRoom = room.id;
    $('room-label').textContent = roomLabel(room.id);
  }

  setMyName(name: string) {
    this.myName = name;
    const input = $<HTMLInputElement>('name-input');
    if (document.activeElement !== input) input.value = name;
  }

  setWalk(name: string) { $('walk-name').textContent = name; }

  // ------------------------------------------------------------------ settings: name
  private validateNameField(showError: boolean): string | null {
    const input = $<HTMLInputElement>('name-input'), msg = $('name-msg');
    const name = sanitizeName(input.value);
    const bad = !name && input.value.trim() !== '';
    input.setAttribute('aria-invalid', String(bad && showError));
    if (showError && !name) { msg.textContent = '2–16 letters, numbers, spaces, dots, dashes or underscores.'; msg.className = 'field-msg bad'; }
    else if (!showError) { msg.textContent = ''; msg.className = 'field-msg'; }
    return name;
  }
  private submitName() {
    const name = this.validateNameField(true);
    if (!name) return;
    const msg = $('name-msg');
    if (name === this.myName) { msg.textContent = 'That is already your name.'; msg.className = 'field-msg'; return; }
    if (!this.actions.rename(name)) { msg.textContent = 'Not connected — try again once you are back online.'; msg.className = 'field-msg bad'; return; }
    msg.textContent = 'Saving…'; msg.className = 'field-msg';
    $<HTMLButtonElement>('name-save').disabled = true;
    this.namePending = window.setTimeout(() => this.nameResult(false, 'No answer from the server. Try again.'), 6000);
  }
  /** Called when the server confirms our rename (or rejects it). */
  nameResult(ok: boolean, text: string) {
    if (this.namePending !== null) { clearTimeout(this.namePending); this.namePending = null; }
    $<HTMLButtonElement>('name-save').disabled = false;
    const msg = $('name-msg');
    msg.textContent = text;
    msg.className = 'field-msg ' + (ok ? 'ok' : 'bad');
  }

  // ------------------------------------------------------------------ settings: rooms
  private rooms: RoomSummary[] | null = null;
  private requestRooms() {
    const list = $('room-list');
    if (!this.actions.listRooms()) { this.rooms = null; list.innerHTML = ''; this.roomMsg('Connect to see the graveyards.', 'bad'); return; }
    if (!this.rooms) { list.innerHTML = ''; this.roomMsg('Loading graveyards…'); this.roomsLoading = true; }
  }
  private roomsLoading = false;
  setRooms(rooms: RoomSummary[]) {
    this.rooms = rooms;
    if (this.roomsLoading) { this.roomsLoading = false; this.roomMsg(''); }
    this.renderRoomControls();
  }
  private renderRoomControls() {
    const list = $('room-list');
    if (!this.rooms) return;
    list.replaceChildren(...this.rooms.map((r) => {
      const li = document.createElement('li');
      const here = r.id === this.currentRoom, full = r.players >= r.capacity;
      const label = document.createElement('span');
      label.innerHTML = `<b></b> <span class="count"></span>`;
      (label.firstChild as HTMLElement).textContent = roomLabel(r.id);
      (label.lastChild as HTMLElement).textContent = r.players === 0 && !here ? 'empty' : `${r.players}/${r.capacity}`;
      li.append(label);
      if (here) {
        const s = document.createElement('span'); s.className = 'here'; s.textContent = 'You are here'; li.append(s);
      } else {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'btn btn-small btn-quiet';
        b.textContent = full ? 'Full' : 'Join';
        b.disabled = full || this.status.kind !== 'connected' || this.roomPending !== null;
        b.addEventListener('click', () => this.joinRoom(r.id));
        li.append(b);
      }
      return li;
    }));
  }
  private joinRoom(id: string) {
    if (!this.actions.joinRoom(id)) { this.roomMsg('Not connected.', 'bad'); return; }
    this.roomMsg(`Moving to ${roomLabel(id)}…`);
    this.roomPending = window.setTimeout(() => this.roomResult(false, 'No answer from the server. Try again.'), 6000);
    this.renderRoomControls();
  }
  /** Called on the welcome that follows a room switch, or on a room error. */
  roomResult(ok: boolean, text: string) {
    if (this.roomPending === null) return;
    clearTimeout(this.roomPending); this.roomPending = null;
    this.roomMsg(text, ok ? 'ok' : 'bad');
    if (ok) this.actions.listRooms(); else this.renderRoomControls();
  }
  get roomSwitchPending(): boolean { return this.roomPending !== null; }
  private roomMsg(text: string, kind: '' | 'ok' | 'bad' = '') {
    const m = $('room-msg'); m.textContent = text; m.className = 'field-msg ' + kind;
  }

  private clearPending() {
    if (this.namePending !== null) this.nameResult(false, 'Connection lost before the name was saved.');
    if (this.roomPending !== null) this.roomResult(false, 'Connection lost. Try again once reconnected.');
  }

  openSettings() {
    $('name-msg').textContent = '';
    $<HTMLInputElement>('name-input').value = this.myName;
    this.dialog.showModal();
    this.requestRooms();
  }
}
