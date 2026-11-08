import type { NetStatus } from '../net/connection.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing from index.html`);
  return el as T;
};

export interface HudActions {
  retry(): void;
}

/**
 * The minimal HUD. It only ever shows information that comes from the game or the server:
 * the online count is the server's count of connected players.
 */
export class Hud {
  private readonly actions: HudActions;
  private status: NetStatus = { kind: 'connecting', attempt: 1, retrying: false };
  private bannerTimer: number | null = null;

  constructor(actions: HudActions) {
    this.actions = actions;
    $('net-retry').addEventListener('click', () => actions.retry());
    $('net-reload').addEventListener('click', () => location.reload());
    this.setStatus(this.status);
  }

  // ------------------------------------------------------------------ fatal
  fatal(message: string) {
    const el = $('fatal');
    el.textContent = message;
    el.hidden = false;
  }

  /** Brief message near the bottom of the screen. */
  private toastTimer: number | null = null;
  toast(text: string) {
    const el = $('toast');
    el.textContent = text;
    el.hidden = false;
    if (this.toastTimer !== null) clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => { el.hidden = true; }, 2500);
  }

  // ------------------------------------------------------------------ connection
  setStatus(s: NetStatus) {
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
        break;
      case 'connecting':
        banner.hidden = !s.retrying;   // the very first attempt is shown by the online chip only
        text.textContent = s.retrying ? 'Connection lost. Reconnecting…' : 'Connecting to the graveyard…';
        $('online-text').textContent = s.retrying ? 'Reconnecting…' : 'Connecting…';
        break;
      case 'reconnecting':
        banner.hidden = false; retry.hidden = false;
        countdown('Connection lost. You are still in the world while we reconnect.', s.retryAt);
        $('online-text').textContent = 'Reconnecting…';
        break;
      case 'offline':
        banner.hidden = false; retry.hidden = false;
        countdown(navigator.onLine ? 'Can’t reach the game server.' : 'You appear to be offline.', s.retryAt);
        $('online-text').textContent = 'Offline';
        break;
      case 'refused':
        banner.hidden = false; retry.hidden = false;
        countdown(s.message, s.retryAt);
        $('online-text').textContent = 'Not joined';
        break;
      case 'outdated':
        banner.hidden = false; reload.hidden = false;
        text.textContent = s.message;
        $('online-text').textContent = 'Update needed';
        break;
    }
  }

  setOnline(total: number) {
    $('online-text').textContent = `${total} online`;
    $('online').title = `${total} ${total === 1 ? 'owl' : 'owls'} in the graveyard right now`;
  }
}
