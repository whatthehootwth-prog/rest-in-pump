const SEEN_KEY = 'rip.tutorial.seen';

/**
 * "How to play": one illustrated card page, shown the first time someone enters the graveyard
 * and any time from the ? button in the top bar. Remembered per browser (best effort).
 */
export class Tutorial {
  private readonly dlg = document.getElementById('tutorial') as HTMLDialogElement;
  /** Called after the player closes it (the game gives the canvas focus back). */
  onClose: () => void = () => {};

  constructor() {
    document.getElementById('tut-go')!.addEventListener('click', () => this.dlg.close());
    document.getElementById('help-btn')!.addEventListener('click', () => this.open());
    this.dlg.addEventListener('click', (e) => { if (e.target === this.dlg) this.dlg.close(); });
    this.dlg.addEventListener('close', () => {
      try { localStorage.setItem(SEEN_KEY, '1'); } catch { /* private mode: it shows again next time */ }
      this.onClose();
    });
  }

  get seen(): boolean {
    try { return localStorage.getItem(SEEN_KEY) === '1'; } catch { return false; }
  }

  open(): void {
    if (this.dlg.open) return;
    if (document.querySelector('dialog[open]')) return;   // never stack on top of a grave / offering dialog
    this.dlg.showModal();
    (document.getElementById('tut-go') as HTMLButtonElement).focus();
  }

  /** First visit only. */
  openIfNew(): void { if (!this.seen) this.open(); }
}
