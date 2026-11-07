import { GRAVE_TIERS } from '../../../shared/graves.ts';
import type { PlotFocus } from '../world/graves.ts';
import { dateLabel, h } from './dom.ts';

/**
 * The card shown when the player walks up to a plot: an empty grave (bury here), a reserved one,
 * or a real grave with the meme's logo, name, the creator's message and wallet.
 */
export class PlotCard {
  private readonly el = document.getElementById('plot-card') as HTMLElement;
  private key = '';
  private readonly onBury: (plotId: number) => void;
  canBury = false;

  constructor(onBury: (plotId: number) => void) { this.onBury = onBury; }

  show(focus: PlotFocus | null): void {
    const key = !focus ? '' : focus.kind === 'grave' ? `g${focus.grave.id}` : `${focus.kind}${focus.plot.id}:${this.canBury}`;
    if (key === this.key) return;
    this.key = key;
    if (!focus) { this.el.hidden = true; this.el.replaceChildren(); return; }
    this.el.hidden = false;
    if (focus.kind === 'empty') {
      this.el.replaceChildren(
        h('div', { class: 'pc-title' }, `Empty grave #${focus.plot.id}`),
        h('p', { class: 'pc-text' }, 'Bury a dead meme here, for good.'),
        h('button', { class: 'btn', type: 'button', disabled: !this.canBury, onclick: () => this.onBury(focus.plot.id) },
          'Bury a meme here ', h('kbd', { class: 'hide-touch' }, 'E')),
        ...(this.canBury ? [] : [h('p', { class: 'pc-note' }, 'Waiting for the connection to the graveyard…')]),
      );
    } else if (focus.kind === 'reserved') {
      this.el.replaceChildren(
        h('div', { class: 'pc-title' }, `Grave #${focus.plot.id}`),
        h('p', { class: 'pc-text' }, 'Someone is burying a meme here right now.'),
      );
    } else {
      const g = focus.grave, tier = GRAVE_TIERS[g.tier - 1];
      const icon = g.meme.icon
        ? h('img', { class: 'pc-icon', src: g.meme.icon, alt: '' })
        : h('div', { class: 'pc-icon pc-icon-ph', 'aria-hidden': 'true' }, (g.meme.symbol || '?').slice(0, 1).toUpperCase());
      this.el.replaceChildren(
        h('div', { class: 'pc-meme' }, icon,
          h('div', {}, h('div', { class: 'pc-title' }, g.meme.name), h('div', { class: 'pc-sub' }, `$${g.meme.symbol} · ${tier.name}`))),
        h('blockquote', { class: 'pc-msg' }, g.message),
        h('p', { class: 'pc-note' }, 'Buried by ', h('b', {}, g.creator), ` · ${dateLabel(g.createdAt)} · grave #${g.plot}`),
        h('p', { class: 'pc-contract' }, g.meme.contract),
      );
    }
  }

  /** E key: bury at the focused empty plot. */
  press(focus: PlotFocus | null): void {
    if (focus?.kind === 'empty' && this.canBury) this.onBury(focus.plot.id);
  }
}
