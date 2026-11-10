import {
  GRAVE_LEVELS, OFFERING_ITEMS, itemName, levelFor, levelName, nearLabel, nextLevelIn, usdLabel,
  type GraveDetail, type GraveInfo, type GraveLevel, type MemorialView, type OfferingItem, type PaymentView, type PriceConfig,
} from '../../../shared/graves.ts';
import { api } from '../net/api.ts';
import type { Wallet } from '../wallet/wallet.ts';
import { h } from './dom.ts';
import { PayFlow } from './payflow.ts';

const MINT_POLL_MS = 3000;
const MINT_POLL_FOR_MS = 3 * 60_000;
/** How rare each gift looks (by price, cheapest first). */
const RARITY = ['common', 'common', 'rare', 'rare', 'epic', 'legendary'] as const;
const usdText = (usd: string) => (Number(usd) < 1 ? `$${Number(usd).toFixed(2)}` : `$${usd}`);

/**
 * "Leave a gift": pick a gift (each has a fixed USD price, paid in NEAR, and gives the grave EXP) → send it →
 * the grave gains that EXP and levels up at milestones. A wallet's first gift to a grave earns that grave's
 * Memorial NFT, minted on NEAR. Desktop: the NFT and level on the left, gifts on the right; phones: top to bottom.
 */
export class OfferingDialog {
  private readonly dlg = document.getElementById('offer-dlg') as HTMLDialogElement;
  private readonly body = document.getElementById('offer-body') as HTMLElement;
  private readonly wallet: Wallet;
  private readonly flow: PayFlow;
  private config: PriceConfig | null = null;
  private configError: string | null = null;
  private grave: GraveInfo | null = null;
  private detail: GraveDetail | null = null;
  private detailFor = '';
  private item: OfferingItem = 'candle';
  /** The grave's EXP when the gift was sent (for the EXP bar animation on the done screen). */
  private expBefore = 0;
  private memorial: MemorialView | null = null;
  private mintPolling = false;

  constructor(wallet: Wallet, toast: (t: string) => void) {
    this.wallet = wallet;
    this.flow = new PayFlow(wallet, {
      render: () => this.render(), isOpen: () => this.dlg.open, close: () => this.dlg.close(), toast,
      doneToast: (p) => `${itemName(p.item ?? '')} left at $${p.meme.symbol}.`,
    }, 'offering');
    this.dlg.addEventListener('close', () => this.flow.stopTimer());
    this.dlg.addEventListener('click', (e) => { if (e.target === this.dlg) this.dlg.close(); });
    wallet.onChange(() => { if (this.dlg.open) { this.render(); void this.loadDetail(); } });
  }

  async open(grave: GraveInfo): Promise<void> {
    if (this.grave?.id !== grave.id || !this.flow.open) {
      this.flow.reset();
      this.item = 'candle'; this.memorial = null;
    }   // else: an unfinished gift for this grave, continue it
    this.grave = grave;
    this.dlg.showModal();
    this.render();
    await Promise.all([this.loadConfig(), this.loadDetail()]);
  }

  /** The grave changed live (someone else's gift): refresh what is shown. */
  graveUpdated(g: GraveInfo) {
    if (this.grave?.id !== g.id) return;
    this.grave = g;
    if (this.dlg.open) { this.render(); void this.loadDetail(true); }
  }

  /** Continue a gift found after a refresh / wallet redirect. */
  async resume(p: PaymentView, redirectTx: { hash: string; account: string | null } | null): Promise<void> {
    if (!p.grave) return;
    this.grave = p.grave; this.item = (p.item as OfferingItem) ?? 'candle'; this.expBefore = p.grave.exp;
    void this.loadConfig();
    await this.flow.resume(p, redirectTx);
    this.afterPaid();
    if (this.flow.state.s === 'confirming' && !redirectTx) return;
    if (!this.dlg.open) this.dlg.showModal();
    this.render();
  }

  private async loadConfig() {
    if (this.config) return;
    try { this.config = await api.config(); this.configError = null; }
    catch (e) { this.configError = (e as Error).message; }
    this.render();
  }

  private async loadDetail(force = false) {
    if (!this.grave) return;
    const key = `${this.grave.id}:${this.wallet.account ?? ''}`;
    if (!force && key === this.detailFor && this.detail) return;
    try {
      const d = await api.grave(this.grave.id, this.wallet.account);
      if (`${this.grave.id}:${this.wallet.account ?? ''}` !== key) return;
      this.detail = d; this.detailFor = key; this.grave = d.grave;
      if (d.mine) this.memorial = d.mine;
      this.render();
    } catch { /* the dialog still works without the extra detail */ }
  }

  private pay() {
    const g = this.grave, item = this.item;
    if (!g) return;
    this.expBefore = g.exp;
    void this.flow.start(
      () => api.createOffering({ graveId: g.id, item }),
      (p) => p.kind === 'offering' && p.graveId === g.id && p.item === item,
    ).then(() => this.afterPaid());
  }

  /** After a successful gift: show the memorial and follow its minting. */
  private afterPaid() {
    const F = this.flow.state;
    if (F.s !== 'done') return;
    if (F.payment.grave) this.grave = F.payment.grave;
    this.memorial = F.payment.memorial;
    this.detailFor = '';
    void this.followMint();
  }

  private async followMint() {
    if (this.mintPolling || !this.grave || !this.memorial || this.memorial.status === 'minted' || this.memorial.status === 'failed') return;
    if (!this.config?.mintingEnabled) return;
    this.mintPolling = true;
    const until = Date.now() + MINT_POLL_FOR_MS, graveId = this.grave.id, account = this.memorial.account;
    try {
      while (Date.now() < until) {
        await new Promise((r) => setTimeout(r, MINT_POLL_MS));
        let d: GraveDetail;
        try { d = await api.grave(graveId, account); } catch { continue; }
        if (this.grave?.id !== graveId) return;
        this.memorial = d.mine; this.detail = d; this.render();
        if (!d.mine || d.mine.status === 'minted' || d.mine.status === 'failed') return;
      }
    } finally {
      this.mintPolling = false;
    }
  }

  // ------------------------------------------------------------------ rendering

  private render() {
    const g = this.grave;
    if (!g) return;
    const F = this.flow.state;
    const side = h('section', { class: `gift-side lvl-${g.level}` }, nftCard(g), levelCard(g), g.message ? h('blockquote', { class: 'gift-words' }, g.message) : null);
    const main = h('section', { class: `gift-main lvl-${g.level}` },
      h('div', { class: 'gift-head' },
        h('h2', { id: 'offer-title' }, F.s === 'done' ? `$${g.meme.symbol}` : `Leave a gift for $${g.meme.symbol}`),
        h('button', { class: 'gift-x', type: 'button', 'aria-label': 'Close', onclick: () => this.dlg.close() }, '×')),
      F.s === 'done' ? this.renderDone(F.payment) : this.renderForm());
    this.body.replaceChildren(h('div', { class: 'gift-layout' }, side, main));
  }

  private renderForm(): Node {
    const cfg = this.config, g = this.grave!;
    if (!cfg) {
      return this.configError
        ? h('p', { class: 'status bad' }, `Could not load the gifts: ${this.configError}`)
        : h('p', { class: 'status busy' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Loading gifts…');
    }
    // while the wallet / NEAR is working, the choice is locked
    const editable = ['review', 'rejected', 'error', 'expired', 'insufficient'].includes(this.flow.state.s);
    const gifts = h('div', { class: 'gifts', role: 'radiogroup', 'aria-label': 'Gift' },
      ...OFFERING_ITEMS.map((it, i) => {
        const price = cfg.gifts.find((x) => x.id === it.id)?.price ?? null;
        return h('button', {
          class: `gift ${RARITY[i]}`, type: 'button', role: 'radio', 'aria-checked': String(this.item === it.id), disabled: !editable,
          title: price ? nearLabel(price) : undefined,
          onclick: () => { this.item = it.id; this.render(); },
        },
        h('span', { class: 'gift-exp' }, `+${it.exp} EXP`),
        itemArt(it.id),
        h('span', { class: 'gift-name' }, it.name),
        h('span', { class: 'gift-usd' }, usdText(it.usd)));
      }));
    const chosen = OFFERING_ITEMS.find((i) => i.id === this.item)!;
    const price = cfg.gifts.find((x) => x.id === this.item)?.price ?? null;
    const amount = this.flow.payment?.amount ?? price;
    if (!amount || !cfg.nearUsd) {
      return h('div', {}, gifts, h('p', { class: 'status bad' }, 'Could not get the NEAR price right now, so gifts are paused for a moment. Try again in a minute.'));
    }
    const label = nearLabel(amount);
    return h('div', { class: 'gift-form' },
      gifts,
      expPreview(g, chosen.exp),
      this.memorialNote(),
      h('div', { class: 'gift-go' },
        this.flow.view({
          price: label, decimals: cfg.decimals, solo: true,
          actionLabel: `Leave ${chosen.name.toLowerCase()} · ${label}`, connectLabel: `Connect wallet & leave ${chosen.name.toLowerCase()}`,
          onAction: () => this.pay(), onClose: () => this.dlg.close(),
        }),
        h('p', { class: 'gift-fine' }, `${label} (about ${usdLabel(amount, cfg.nearUsd)}) goes to ${cfg.receiver}.`)));
  }

  private memorialNote(): Node {
    const cfg = this.config, d = this.detail, acct = this.wallet.account;
    const off = cfg && !cfg.mintingEnabled ? ' (minted once minting switches on)' : '';
    if (acct && d?.mine) {
      const m = d.mine;
      const which = m.status === 'minted' && m.serial ? ` #${String(m.serial).padStart(3, '0')}` : '';
      return h('p', { class: 'gift-nft owned' }, h('b', {}, 'You own'), ` this grave's Memorial NFT${which}. It levels up with the grave.`);
    }
    return h('p', { class: 'gift-nft' }, h('b', {}, 'First gift here?'), ` You get this grave's Memorial NFT${off}.`);
  }

  private renderDone(p: PaymentView): Node {
    const g = this.grave!, m = this.memorial, cfg = this.config;
    const it = OFFERING_ITEMS.find((i) => i.id === p.item);
    const before = Math.min(this.expBefore, g.exp), levelUp = levelFor(before) !== g.level;
    let nft: Node | null;
    if (!m) nft = null;
    else if (m.status === 'minted') {
      const link = cfg?.nftContract && m.tokenId
        ? h('a', { href: `https://nearblocks.io/nft-token/${cfg.nftContract}/${encodeURIComponent(m.tokenId)}`, target: '_blank', rel: 'noopener noreferrer' }, 'View')
        : null;
      nft = h('p', { class: 'gift-nft owned' }, `Memorial #${String(m.serial ?? 0).padStart(3, '0')} is in your wallet. `, link);
    } else if (m.status === 'failed') {
      nft = h('p', { class: 'field-msg bad' }, m.error ?? 'Minting your Memorial NFT failed.');
    } else if (!cfg?.mintingEnabled) {
      nft = h('p', { class: 'gift-nft' }, 'Your Memorial NFT is saved and will be minted to your wallet once minting switches on.');
    } else {
      nft = h('p', { class: 'gift-nft busy-line' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Minting your Memorial NFT…');
    }
    const art = itemArt(p.item ?? ''); art.setAttribute('width', '84'); art.setAttribute('height', '84');
    return h('div', { class: 'gift-done' },
      h('div', { class: 'celebrate' },
        h('div', { class: 'cele-art' }, art, h('span', { class: 'exp-pop' }, `+${it?.exp ?? 0} EXP`)),
        levelUp
          ? h('p', { class: `cele-title levelup lvl-${g.level}` }, 'LEVEL UP!')
          : h('p', { class: 'cele-title' }, 'Respect paid'),
        h('p', { class: 'cele-sub' }, levelUp
          ? `$${g.meme.symbol} is now a Level ${g.level} ${levelName(g.level)}. Every Memorial NFT just evolved.`
          : `${itemName(p.item ?? '')} left at $${g.meme.symbol}.`)),
      expBar(g, before),
      nft,
      h('div', { class: 'dlg-actions' }, h('button', { class: 'btn btn-go', type: 'button', onclick: () => this.dlg.close() }, 'R.I.P.')));
  }
}

// ------------------------------------------------------------------ pieces

/** The grave's live Memorial NFT picture (the same art every holder's NFT shows). */
function nftCard(g: GraveInfo): Node {
  return h('figure', { class: 'nft-frame' },
    h('img', { src: `/nft/grave/${g.id}/media.svg?exp=${g.exp}`, alt: `$${g.meme.symbol} Memorial NFT, level ${g.level}`, width: 1080, height: 1380 }),
    h('figcaption', {}, 'Memorial NFT'));
}

/** Big level badge, tier name and EXP bar. */
function levelCard(g: GraveInfo): Node {
  return h('div', { class: 'lvl-card' },
    h('div', { class: 'lvl-badge', 'aria-hidden': 'true' }, h('small', {}, 'LV'), h('b', {}, String(g.level))),
    h('div', { class: 'lvl-txt' },
      h('p', { class: 'lvl-name' }, levelName(g.level)),
      expBar(g, g.exp)));
}

/** EXP bar for the current level; `from` lower than the grave's EXP animates the gain. */
function expBar(g: GraveInfo, from: number): Node {
  const { floor, ceil } = band(g.level);
  const pct = (exp: number) => ceil === null ? 100 : Math.max(0, Math.min(100, ((exp - floor) / (ceil - floor)) * 100));
  const start = levelFor(from) === g.level ? pct(from) : 0;
  const fill = h('span', { class: 'exp-fill', style: `width:${start}%` });
  if (start !== pct(g.exp)) requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.width = `${pct(g.exp)}%`; }));
  else fill.style.width = `${pct(g.exp)}%`;
  const next = nextLevelIn(g.exp);
  return h('div', { class: 'exp-wrap' },
    h('div', { class: 'exp-bar', role: 'progressbar', 'aria-label': 'EXP to the next level', 'aria-valuemin': String(floor), 'aria-valuemax': String(ceil ?? g.exp), 'aria-valuenow': String(g.exp) },
      fill, h('em', {}, ceil === null ? `${g.exp.toLocaleString('en-US')} EXP · MAX` : `${g.exp.toLocaleString('en-US')} / ${ceil.toLocaleString('en-US')} EXP`)),
    h('p', { class: 'exp-next' }, next === null ? 'Max level reached. Legend status.' : `${next.toLocaleString('en-US')} EXP to ${levelName((g.level + 1) as GraveLevel)}`));
}

/** What the chosen gift would do: a ghost segment on the bar and a level-up callout. */
function expPreview(g: GraveInfo, add: number): Node {
  const after = g.exp + add, up = levelFor(after) !== g.level;
  const { floor, ceil } = band(g.level);
  const pct = (exp: number) => ceil === null ? 100 : Math.max(0, Math.min(100, ((exp - floor) / (ceil - floor)) * 100));
  return h('div', { class: `exp-preview${up ? ' up' : ''}` },
    h('div', { class: 'exp-bar thin' },
      h('span', { class: 'exp-ghost', style: `width:${pct(after)}%` }),
      h('span', { class: 'exp-fill', style: `width:${pct(g.exp)}%` })),
    h('p', {}, up
      ? h('b', {}, `+${add} EXP · LEVEL UP to ${levelName(levelFor(after))}!`)
      : h('span', {}, h('b', {}, `+${add} EXP`), ceil === null ? ' for a legend' : ` · ${(ceil - after).toLocaleString('en-US')} more to Level ${g.level + 1}`)));
}

function band(level: GraveLevel): { floor: number; ceil: number | null } {
  const next = GRAVE_LEVELS.find((l) => l.level === level + 1);
  return { floor: GRAVE_LEVELS[level - 1].min, ceil: next ? next.min : null };
}

const SVG_NS = 'http://www.w3.org/2000/svg';
/** Small drawn icons for the gifts (inline SVG, no emoji). */
export function itemArt(id: string): SVGSVGElement {
  const paths: Record<string, string> = {
    candle: '<rect x="9" y="10" width="6" height="11" rx="1" fill="#efe6cf"/><path d="M12 3c2 2.5 2 4.5 0 6-2-1.5-2-3.5 0-6z" fill="#f2a93b"/>',
    flowers: '<path d="M12 21v-8" stroke="#5c8f4e" stroke-width="2"/><circle cx="12" cy="8" r="3" fill="#e2557a"/><circle cx="7.5" cy="11" r="2.4" fill="#f1c84b"/><circle cx="16.5" cy="11" r="2.4" fill="#f1c84b"/>',
    noodles: '<path d="M5 9h14l-2 12H7z" fill="#f4f1ea"/><rect x="5" y="12" width="14" height="3" fill="#d6453d"/><path d="M9 9c0-3 1-5 1-6M13 9c0-3 1-5 1-6" stroke="#e8c35a" stroke-width="1.6" fill="none"/>',
    rug: '<rect x="4" y="6" width="16" height="12" rx="1" fill="#a3403a"/><path d="M4 10h16M4 14h16" stroke="#e8c35a" stroke-width="1.6"/><path d="M4 6v12M20 6v12" stroke="#efe6cf" stroke-width="2" stroke-dasharray="1.5 1.5"/>',
    diamond: '<path d="M6 9l3-4h6l3 4-6 11z" fill="#7fd3e8"/><path d="M6 9h12M9 5l3 15 3-15" stroke="#3d93ad" stroke-width="1" fill="none"/>',
    copium: '<rect x="8" y="6" width="8" height="15" rx="4" fill="#6fae5d"/><rect x="10.5" y="2.5" width="3" height="4" fill="#8a8a8a"/><text x="12" y="16" font-size="5" text-anchor="middle" font-family="Arial" font-weight="900" fill="#1b1a1f">CO</text>',
  };
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '44');
  svg.setAttribute('height', '44');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = paths[id] ?? '';   // static, trusted markup
  return svg;
}
