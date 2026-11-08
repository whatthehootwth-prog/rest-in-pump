import {
  OFFERING_ITEMS, formatUnits, itemName, levelName, nextLevelIn, parseUnits,
  type GraveDetail, type GraveInfo, type MemorialView, type OfferingItem, type PaymentView, type PriceConfig,
} from '../../../shared/graves.ts';
import { api } from '../net/api.ts';
import type { Wallet } from '../wallet/wallet.ts';
import { h, shortAccount } from './dom.ts';
import { PayFlow } from './payflow.ts';
import { memeChip } from './creategrave.ts';

const MINT_POLL_MS = 3000;
const MINT_POLL_FOR_MS = 3 * 60_000;
const QUICK_AMOUNTS = ['10000', '25000', '100000'];

/**
 * "Leave an offering": pick an item + a WTH amount (at least the minimum) → pay → the grave's community count
 * goes up by one. A wallet's first offering to a grave earns that grave's Memorial NFT, minted on NEAR.
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
  private step: 'choose' | 'pay' = 'choose';
  private item: OfferingItem = 'candle';
  private amount = '';
  private amountError: string | null = null;
  private memorial: MemorialView | null = null;
  private mintPolling = false;

  constructor(wallet: Wallet, toast: (t: string) => void) {
    this.wallet = wallet;
    this.flow = new PayFlow(wallet, {
      render: () => this.render(), isOpen: () => this.dlg.open, close: () => this.dlg.close(), toast,
      doneToast: (p) => `Your ${itemName(p.item ?? '')} was left at $${p.meme.symbol}.`,
    }, 'offering');
    document.getElementById('offer-close')!.addEventListener('click', () => this.dlg.close());
    this.dlg.addEventListener('close', () => this.flow.stopTimer());
    wallet.onChange(() => { if (this.dlg.open) { this.render(); void this.loadDetail(); } });
  }

  async open(grave: GraveInfo): Promise<void> {
    if (this.grave?.id !== grave.id || !this.flow.open) {
      this.flow.reset();
      this.step = 'choose'; this.item = 'candle'; this.amount = ''; this.amountError = null; this.memorial = null;
    } else {
      this.step = 'pay';   // an unfinished payment for this grave: continue it
    }
    this.grave = grave;
    this.dlg.showModal();
    this.render();
    await Promise.all([this.loadConfig(), this.loadDetail()]);
  }

  /** The grave changed live (someone else's offering): refresh what is shown. */
  graveUpdated(g: GraveInfo) {
    if (this.grave?.id !== g.id) return;
    this.grave = g;
    if (this.dlg.open) { this.render(); void this.loadDetail(true); }
  }

  /** Continue an offering payment found after a refresh / wallet redirect. */
  async resume(p: PaymentView, redirectTx: { hash: string; account: string | null } | null): Promise<void> {
    if (!p.grave) return;
    this.grave = p.grave; this.item = (p.item as OfferingItem) ?? 'candle'; this.step = 'pay';
    void this.loadConfig();
    if (this.config) this.amount = formatUnits(p.amount, this.config.decimals, this.config.decimals).replace(/,/g, '');
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

  private validAmount(): bigint | null {
    if (!this.config) return null;
    const raw = this.amount.replace(/[,\s]/g, '');
    let v: bigint;
    try { v = parseUnits(raw, this.config.decimals); } catch { this.amountError = 'Enter a WTH amount, like 10000.'; return null; }
    if (v < parseUnits(this.config.offeringMin, this.config.decimals)) { this.amountError = `The minimum offering is ${formatUnits(parseUnits(this.config.offeringMin, this.config.decimals).toString(), this.config.decimals)} WTH.`; return null; }
    this.amountError = null;
    return v;
  }

  private pay() {
    const g = this.grave, amt = this.validAmount();
    if (!g || amt === null) { this.step = 'choose'; this.render(); return; }
    const amount = this.amount.replace(/[,\s]/g, '');
    void this.flow.start(
      () => api.createOffering({ graveId: g.id, item: this.item, amount }),
      (p) => p.kind === 'offering' && p.graveId === g.id && p.item === this.item && p.amount === amt.toString(),
    ).then(() => this.afterPaid());
  }

  /** After a successful offering: show the memorial and follow its minting. */
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
    const title = document.getElementById('offer-title');
    if (title) title.textContent = `Leave an offering at $${g.meme.symbol}`;
    const steps = h('ol', { class: 'steps', 'aria-label': 'Steps' },
      h('li', { class: this.step === 'choose' ? 'on' : 'done' }, 'Offering'), h('li', { class: this.step === 'pay' ? 'on' : '' }, 'Pay'));
    this.body.replaceChildren(steps, graveSummary(g), this.step === 'choose' ? this.renderChoose() : this.renderPay());
  }

  private memorialNote(): Node {
    const cfg = this.config, d = this.detail, acct = this.wallet.account;
    const off = cfg && !cfg.mintingEnabled ? ' Memorial minting is not switched on yet; yours is recorded and will be minted to your wallet once it is.' : '';
    if (acct && d?.mine) {
      const m = d.mine;
      const which = m.status === 'minted' && m.serial ? ` (Memorial #${String(m.serial).padStart(3, '0')})` : '';
      return h('p', { class: 'field-msg' }, `You already earned this grave's Memorial NFT${which}. One per wallet — more offerings still grow the grave.${off}`);
    }
    return h('p', { class: 'field-msg' }, `${acct && d ? 'This is your first offering here: it' : 'Your first offering to a grave'} earns you its Memorial NFT, minted on NEAR. It evolves as the grave levels up.${off}`);
  }

  private renderChoose() {
    const cfg = this.config;
    const items = h('div', { class: 'items', role: 'radiogroup', 'aria-label': 'Offering' },
      ...OFFERING_ITEMS.map((it) => h('button', {
        class: 'item', type: 'button', role: 'radio', 'aria-checked': String(this.item === it.id),
        onclick: () => { this.item = it.id; this.render(); },
      }, itemArt(it.id), h('span', {}, it.name))));
    const input = h('input', {
      id: 'offer-amount', inputmode: 'decimal', autocomplete: 'off', value: this.amount,
      placeholder: cfg ? cfg.offeringMin : '10000', 'aria-describedby': 'offer-amount-msg',
      oninput: (e: Event) => { this.amount = (e.target as HTMLInputElement).value; },
      onkeydown: (e: Event) => { if ((e as KeyboardEvent).key === 'Enter') { e.preventDefault(); next(); } },
    });
    const next = () => { if (this.validAmount() !== null) this.step = 'pay'; this.render(); };
    const quick = h('div', { class: 'quick' }, ...QUICK_AMOUNTS.map((a) =>
      h('button', { class: 'amt', type: 'button', onclick: () => { this.amount = a; this.amountError = null; this.render(); } }, Number(a).toLocaleString('en-US'))));
    return h('div', { class: 'dlg-step' },
      h('div', { class: 'lbl' }, 'What do you leave?'), items,
      h('label', { class: 'lbl', for: 'offer-amount' }, 'WTH amount'),
      h('div', { class: 'row' }, input, h('span', { class: 'unit' }, 'WTH')), quick,
      h('p', { id: 'offer-amount-msg', class: this.amountError ? 'field-msg bad' : 'field-msg' },
        this.amountError ?? (cfg ? `At least ${Number(cfg.offeringMin).toLocaleString('en-US')} WTH. Every offering counts as one, whatever the amount.` : 'Loading prices…')),
      this.memorialNote(),
      h('div', { class: 'dlg-actions' }, h('button', { class: 'btn', type: 'button', disabled: !cfg, onclick: next }, 'Review')));
  }

  private renderPay() {
    const cfg = this.config, g = this.grave!;
    const F = this.flow.state;
    if (F.s === 'done') return this.renderDone(F.payment);
    if (!cfg) {
      return h('div', { class: 'dlg-step' }, this.configError
        ? h('p', { class: 'status bad' }, `Could not load prices: ${this.configError}`)
        : h('p', { class: 'status busy' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Loading prices…'));
    }
    let amount = this.flow.payment?.amount ?? null;
    if (!amount) { const v = this.validAmount(); amount = v === null ? null : v.toString(); }
    const price = amount ? `${formatUnits(amount, cfg.decimals)} WTH` : '—';
    const acct = this.wallet.account;
    const summary = h('dl', { class: 'summary' },
      h('dt', {}, 'Grave'), h('dd', {}, `$${g.meme.symbol} · plot #${g.plot}`),
      h('dt', {}, 'Offering'), h('dd', {}, itemName(this.item)),
      h('dt', {}, 'Amount'), h('dd', {}, h('b', {}, price)),
      h('dt', {}, 'Paid to'), h('dd', { class: 'mono' }, cfg.receiver),
      h('dt', {}, 'Wallet'), h('dd', {}, acct ? shortAccount(acct) : 'not connected'));
    return h('div', { class: 'dlg-step' }, summary,
      this.flow.view({
        price, decimals: cfg.decimals, payLabel: `Offer ${price}`, onPay: () => this.pay(), onClose: () => this.dlg.close(),
        back: () => { this.step = 'choose'; this.render(); },
      }));
  }

  private renderDone(p: PaymentView) {
    const g = this.grave!, m = this.memorial, cfg = this.config;
    let nft: Node;
    if (!m) nft = h('p', { class: 'field-msg' }, 'Memorial status is unavailable right now.');
    else if (m.status === 'minted') {
      const link = cfg?.nftContract && m.tokenId
        ? h('a', { href: `https://nearblocks.io/nft-token/${cfg.nftContract}/${encodeURIComponent(m.tokenId)}`, target: '_blank', rel: 'noopener noreferrer' }, 'View on NearBlocks')
        : null;
      nft = h('p', { class: 'status ok' }, `$${g.meme.symbol} — Memorial #${String(m.serial ?? 0).padStart(3, '0')} is in ${shortAccount(m.account)}. `, link);
    } else if (m.status === 'failed') {
      nft = h('p', { class: 'status bad' }, m.error ?? 'Minting your Memorial NFT failed.');
    } else if (!cfg?.mintingEnabled) {
      nft = h('p', { class: 'field-msg' }, 'Your Memorial NFT is recorded. Minting is not switched on yet; it will be minted to your wallet as soon as it is.');
    } else {
      nft = h('p', { class: 'status busy', role: 'status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }),
        m.error ? `${m.error} Your Memorial NFT will arrive in your wallet.` : 'Minting your Memorial NFT on NEAR…');
    }
    return h('div', { class: 'dlg-step done' },
      h('p', { class: 'status ok' }, `Your ${itemName(p.item ?? '').toLowerCase()} was left at $${g.meme.symbol}. The grave now has ${g.offerings.toLocaleString('en-US')} ${g.offerings === 1 ? 'offering' : 'offerings'}.`),
      h('div', { class: 'lbl' }, 'Your Memorial NFT'),
      nft,
      h('div', { class: 'dlg-actions' }, h('button', { class: 'btn', type: 'button', onclick: () => this.dlg.close() }, 'Pay respects')));
  }
}

/** Meme, level and progress to the next level. */
export function graveSummary(g: GraveInfo): Node {
  const next = nextLevelIn(g.offerings);
  return h('div', { class: 'grave-sum' },
    memeChip(g.meme),
    levelLine(g),
    next === null ? null : progress(g));
}

export function levelLine(g: GraveInfo): Node {
  const next = nextLevelIn(g.offerings);
  return h('p', { class: 'level-line' },
    h('b', {}, `Level ${g.level} · ${levelName(g.level)}`),
    ` · ${g.offerings.toLocaleString('en-US')} ${g.offerings === 1 ? 'offering' : 'offerings'}`,
    next === null ? ' · max level' : ` · ${next.toLocaleString('en-US')} to Level ${g.level + 1}`);
}

function progress(g: GraveInfo): Node {
  const next = nextLevelIn(g.offerings)!;
  const floor = [0, 10, 100, 1000][g.level - 1], span = (g.offerings + next) - floor;
  const pct = Math.max(2, Math.round(((g.offerings - floor) / span) * 100));
  return h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(span), 'aria-valuenow': String(g.offerings - floor), 'aria-label': 'Progress to the next level' },
    h('span', { style: `width:${pct}%` }));
}

const SVG_NS = 'http://www.w3.org/2000/svg';
/** Small drawn icons for the offering items (inline SVG, no emoji). */
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
  svg.setAttribute('width', '28');
  svg.setAttribute('height', '28');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = paths[id] ?? '';   // static, trusted markup
  return svg;
}
