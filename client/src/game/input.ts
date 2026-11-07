/** Keyboard + on-screen pad state. Ignores keys while the player is typing in a field or a dialog is open. */
export class Input {
  private readonly keys = new Set<string>();
  private readonly pressHandlers = new Map<string, () => void>();

  constructor() {
    const GAME_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']);
    window.addEventListener('keydown', (e) => {
      if (Input.typing(e.target)) return;
      if (GAME_KEYS.has(e.code)) e.preventDefault();
      if (!e.repeat) this.pressHandlers.get(e.code)?.();
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.keys.clear(); });
  }

  /** True when focus is in a text field or a modal dialog (keys belong to the UI then). */
  static typing(target: EventTarget | null): boolean {
    if (document.querySelector('dialog[open]')) return true;
    const el = target as HTMLElement | null;
    return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
  }

  down(...codes: string[]): boolean {
    if (document.querySelector('dialog[open]')) return false;
    return codes.some((c) => this.keys.has(c));
  }

  /** Calls fn once each time `code` is pressed. */
  onPress(code: string, fn: () => void): void { this.pressHandlers.set(code, fn); }

  /** Wires buttons with data-key="ArrowUp" etc. (touch pad) to the same key state. */
  bindTouchButtons(root: ParentNode): void {
    root.querySelectorAll<HTMLElement>('[data-key]').forEach((b) => {
      const code = b.dataset.key as string;
      const on = (e: Event) => { e.preventDefault(); this.keys.add(code); };
      const off = () => this.keys.delete(code);
      b.addEventListener('pointerdown', on);
      for (const t of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(t, off);
    });
  }
}
