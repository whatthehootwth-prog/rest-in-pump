/**
 * The first scene: title, pitch, "Enter" and "What is Rest In Pump?". The 3D graveyard runs behind it.
 * Nothing joins the multiplayer world until the player presses Enter, so people reading this screen
 * are never counted as players. The player count shown here is the server's real count.
 */
export class Landing {
  private readonly root = document.getElementById('landing') as HTMLElement;
  private readonly about = document.getElementById('about') as HTMLDialogElement;
  private readonly online = document.getElementById('landing-online') as HTMLElement;
  private pollTimer: number | null = null;
  private entered = false;

  constructor(onEnter: () => void) {
    const enter = document.getElementById('enter-btn') as HTMLButtonElement;
    enter.addEventListener('click', () => {
      if (this.entered) return;
      this.entered = true;
      this.stopPolling();
      this.root.classList.add('leaving');
      document.body.classList.remove('landing-open');
      setTimeout(() => { this.root.hidden = true; }, 400);
      onEnter();
    });
    document.getElementById('about-btn')!.addEventListener('click', () => this.about.showModal());
    document.getElementById('about-close')!.addEventListener('click', () => this.about.close());
    this.about.addEventListener('click', (e) => { if (e.target === this.about) this.about.close(); });
  }

  /** The intro is already on screen from the HTML; this turns Enter on once the world is ready. */
  show(): void {
    this.root.hidden = false;
    document.body.classList.add('landing-open');
    const enter = document.getElementById('enter-btn') as HTMLButtonElement;
    enter.disabled = false;
    enter.focus();
    void this.refreshCount();
    this.pollTimer = window.setInterval(() => void this.refreshCount(), 10000);
  }

  private async refreshCount(): Promise<void> {
    try {
      const res = await fetch('/healthz', { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as { players?: unknown };
      const n = typeof data.players === 'number' ? data.players : null;
      if (n === null) throw new Error('bad response');
      this.online.innerHTML = '<span class="dot dot-ok" aria-hidden="true"></span>';
      this.online.append(n === 0 ? 'The graveyard is empty. Be the first owl.' : `${n} ${n === 1 ? 'owl is' : 'owls are'} in the graveyard right now.`);
    } catch {
      this.online.innerHTML = '<span class="dot dot-bad" aria-hidden="true"></span>';
      this.online.append('Can’t reach the game server right now.');
    }
  }

  private stopPolling() {
    if (this.pollTimer !== null) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }
}
