import { levelName, type GraveInfo } from '../../../shared/graves.ts';
import type { PlotFocus } from '../world/graves.ts';
import { h } from './dom.ts';

/**
 * The small card shown when the player walks up to a plot: an empty plot (create a grave), one being created,
 * or a grave (meme, level, offering count, last words, and the offering button). Kept short on purpose;
 * the offering dialog has the details.
 */
export class PlotCard {
  private readonly el = document.getElementById('plot-card') as HTMLElement;
  private key = '';
  private readonly onCreate: (plotId: number) => void;
  private readonly onOffer: (grave: GraveInfo) => void;
  canAct = false;

  constructor(onCreate: (plotId: number) => void, onOffer: (grave: GraveInfo) => void) {
    this.onCreate = onCreate;
    this.onOffer = onOffer;
  }

  show(focus: PlotFocus | null): void {
    const key = !focus ? '' : focus.kind === 'grave'
      ? `g${focus.grave.id}:${focus.grave.offerings}:${this.canAct}`
      : `${focus.kind}${focus.plot.id}:${this.canAct}`;
    if (key === this.key) return;
    this.key = key;
    if (!focus) { this.el.hidden = true; this.el.replaceChildren(); return; }
    this.el.hidden = false;
    const waiting = this.canAct ? [] : [h('p', { class: 'pc-note' }, 'Waiting for the connection to the graveyard…')];
    if (focus.kind === 'empty') {
      this.el.replaceChildren(
        h('div', { class: 'pc-title' }, `Empty plot #${focus.plot.id}`),
        h('p', { class: 'pc-text' }, 'Give a fallen memecoin a grave the whole graveyard can visit.'),
        h('button', { class: 'btn', type: 'button', disabled: !this.canAct, onclick: () => this.onCreate(focus.plot.id) },
          'Create a grave here ', h('kbd', { class: 'hide-touch' }, 'E')),
        ...waiting,
      );
    } else if (focus.kind === 'reserved') {
      this.el.replaceChildren(
        h('div', { class: 'pc-title' }, `Plot #${focus.plot.id}`),
        h('p', { class: 'pc-text' }, 'Someone is creating a grave here right now.'),
      );
    } else {
      const g = focus.grave;
      const icon = g.meme.icon
        ? h('img', { class: 'pc-icon', src: g.meme.icon, alt: '' })
        : h('div', { class: 'pc-icon pc-icon-ph', 'aria-hidden': 'true' }, (g.meme.symbol || '?').slice(0, 1).toUpperCase());
      this.el.replaceChildren(
        h('div', { class: 'pc-meme' }, icon,
          h('div', {},
            h('div', { class: 'pc-title' }, `$${g.meme.symbol}`),
            h('div', { class: 'pc-sub' }, `Level ${g.level} · ${levelName(g.level)} · ${g.offerings.toLocaleString('en-US')} ${g.offerings === 1 ? 'offering' : 'offerings'}`))),
        h('blockquote', { class: 'pc-msg' }, g.message),
        h('button', { class: 'btn', type: 'button', disabled: !this.canAct, onclick: () => this.onOffer(g) },
          'Leave an offering ', h('kbd', { class: 'hide-touch' }, 'E')),
        ...waiting,
      );
    }
  }

  /** E key: create a grave at an empty plot, or leave an offering at a grave. */
  press(focus: PlotFocus | null): void {
    if (!this.canAct) return;
    if (focus?.kind === 'empty') this.onCreate(focus.plot.id);
    else if (focus?.kind === 'grave') this.onOffer(focus.grave);
  }
}
