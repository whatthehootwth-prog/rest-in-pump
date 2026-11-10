import { levelName, type GraveInfo } from '../../../shared/graves.ts';
import type { PlotFocus } from '../world/graves.ts';
import { h } from './dom.ts';

/**
 * The one-line prompt shown when the player stands at a plot, game style:
 *   [icon] $NGMI · Level 3 Honored · Leave an offering [E]
 *   Empty plot #12 · Create a grave [E]
 * The whole pill is the button; details live in the dialogs.
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
    const f = focus;
    const key = !f ? '' : f.kind === 'grave'
      ? `g${f.grave.id}:${f.grave.level}:${f.grave.meme.symbol}:${this.canAct}`
      : `${f.kind}${f.plot.id}:${this.canAct}`;
    if (key === this.key) return;
    this.key = key;
    if (!f) { this.el.hidden = true; this.el.replaceChildren(); return; }
    this.el.hidden = false;
    const kbd = h('kbd', { class: 'hide-touch' }, 'E');
    const action = (label: string, onclick: () => void, lead: (Node | string)[]) => h('button', {
      class: 'pc-pill', type: 'button', disabled: !this.canAct, onclick,
      title: this.canAct ? undefined : 'Waiting for the connection to the graveyard…',
    }, ...lead, h('span', { class: 'pc-action' }, this.canAct ? label : 'Connecting…', this.canAct ? kbd : null));

    if (f.kind === 'empty') {
      this.el.replaceChildren(action('Create a grave', () => this.onCreate(f.plot.id), [h('span', { class: 'pc-what' }, `Empty plot #${f.plot.id}`)]));
    } else if (f.kind === 'reserved') {
      this.el.replaceChildren(h('div', { class: 'pc-pill pc-info' }, `Plot #${f.plot.id} · someone is creating a grave here`));
    } else {
      const g = f.grave;
      const icon = g.meme.icon
        ? h('img', { class: 'pc-icon', src: g.meme.icon, alt: '' })
        : h('span', { class: 'pc-icon pc-icon-ph', 'aria-hidden': 'true' }, (g.meme.symbol || '?').slice(0, 1).toUpperCase());
      this.el.replaceChildren(action('Leave a gift', () => this.onOffer(g), [
        icon,
        h('span', { class: 'pc-what' }, h('b', {}, `$${g.meme.symbol}`), h('span', { class: 'pc-lvl' }, ` · Level ${g.level} ${levelName(g.level).replace(' Grave', '')}`)),
      ]));
    }
  }

  /** E key: create a grave at an empty plot, or leave an offering at a grave. */
  press(focus: PlotFocus | null): void {
    if (!this.canAct) return;
    if (focus?.kind === 'empty') this.onCreate(focus.plot.id);
    else if (focus?.kind === 'grave') this.onOffer(focus.grave);
  }
}

