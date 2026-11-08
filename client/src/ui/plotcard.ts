import type { GraveInfo, MemorialView } from '../../../shared/graves.ts';
import { api } from '../net/api.ts';
import type { Wallet } from '../wallet/wallet.ts';
import type { PlotFocus } from '../world/graves.ts';
import { dateLabel, h, shortAccount } from './dom.ts';
import { levelLine } from './offering.ts';

/**
 * The card shown when the player walks up to a plot: an empty plot (create a grave), one being created,
 * or a real grave with the meme, its memorial level and offering count, the creator's message,
 * and the connected wallet's Memorial NFT for it.
 */
export class PlotCard {
  private readonly el = document.getElementById('plot-card') as HTMLElement;
  private key = '';
  private readonly onCreate: (plotId: number) => void;
  private readonly onOffer: (grave: GraveInfo) => void;
  private readonly wallet: Wallet;
  /** Memorial of the connected wallet per grave ("graveId:account" -> memorial or null), fetched on demand. */
  private readonly mine = new Map<string, MemorialView | null | 'loading' | 'error'>();
  canAct = false;

  constructor(wallet: Wallet, onCreate: (plotId: number) => void, onOffer: (grave: GraveInfo) => void) {
    this.wallet = wallet;
    this.onCreate = onCreate;
    this.onOffer = onOffer;
    wallet.onChange(() => { this.key = ''; });
  }

  /** Forget the cached memorial for a grave (e.g. after an offering). */
  invalidate(graveId: number) {
    for (const k of [...this.mine.keys()]) if (k.startsWith(`${graveId}:`)) this.mine.delete(k);
    this.key = '';
  }

  show(focus: PlotFocus | null): void {
    const acct = this.wallet.account ?? '';
    const key = !focus ? '' : focus.kind === 'grave'
      ? `g${focus.grave.id}:${focus.grave.offerings}:${acct}:${this.canAct}:${this.mineState(focus.grave.id)}`
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
          h('div', {}, h('div', { class: 'pc-title' }, g.meme.name), h('div', { class: 'pc-sub' }, `$${g.meme.symbol} · grave #${g.plot}`))),
        levelLine(g),
        h('blockquote', { class: 'pc-msg' }, g.message),
        h('p', { class: 'pc-note' }, 'Grave created by ', h('b', {}, shortAccount(g.creator)), ` · ${dateLabel(g.createdAt)}`),
        this.memorialLine(g),
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

  private mineState(graveId: number): string {
    const acct = this.wallet.account;
    if (!acct) return 'none';
    const m = this.mine.get(`${graveId}:${acct}`);
    return m === undefined ? 'unknown' : typeof m === 'string' ? m : m === null ? 'no' : `${m.status}${m.serial ?? ''}`;
  }

  private memorialLine(g: GraveInfo): Node {
    const acct = this.wallet.account;
    if (!acct) return h('p', { class: 'pc-note' }, 'Your first offering here earns this grave\'s Memorial NFT.');
    const k = `${g.id}:${acct}`, m = this.mine.get(k);
    if (m === undefined) {
      this.mine.set(k, 'loading');
      api.grave(g.id, acct).then((d) => { this.mine.set(k, d.mine); }).catch(() => { this.mine.set(k, 'error'); }).finally(() => { this.key = ''; });
    }
    if (m === undefined || m === 'loading') return h('p', { class: 'pc-note' }, 'Checking your Memorial NFT…');
    if (m === 'error') return h('p', { class: 'pc-note' }, 'Could not check your Memorial NFT right now.');
    if (m === null) return h('p', { class: 'pc-note' }, 'Your first offering here earns this grave\'s Memorial NFT.');
    if (m.status === 'minted') return h('p', { class: 'pc-note pc-ok' }, `You hold $${g.meme.symbol} — Memorial #${String(m.serial ?? 0).padStart(3, '0')}.`);
    if (m.status === 'failed') return h('p', { class: 'pc-note pc-bad' }, 'Minting your Memorial NFT failed after several tries. It is flagged for the team.');
    return h('p', { class: 'pc-note' }, 'Your Memorial NFT is waiting to be minted.');
  }
}
