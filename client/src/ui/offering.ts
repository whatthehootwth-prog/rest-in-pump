import {
  OFFERING_ITEMS, formatUnits, itemName, levelName, nearLabel, nextLevelIn, parseUnits, usdLabel, usdToYocto,
  type GraveDetail, type GraveInfo, type MemorialView, type OfferingItem, type PaymentView, type PriceConfig,
} from '../../../shared/graves.ts';
import { api } from '../net/api.ts';
import type { Wallet } from '../wallet/wallet.ts';
import { h } from './dom.ts';
import { PayFlow } from './payflow.ts';
import { memeChip } from './creategrave.ts';

const MINT_POLL_MS = 3000;
const MINT_POLL_FOR_MS = 3 * 60_000;
/** Quick picks, in USD (converted to NEAR at the current price). */
const QUICK_USD = ['0.01', '0.1', '1'];
/** yoctoNEAR -> plain decimal string for the input ("0.003571"). */
const nearInput = (yocto: bigint | string) => formatUnits(BigInt(yocto).toString(), 24, 6).replace(/,/g, '');

/**
 * "Leave an offering": pick an item + a NEAR amount (at least the USD minimum) → send it → the grave's community count
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
      this.item = 'candle'; this.amount = ''; this.amountError = null; this.memorial = null;
    }   // else: an unfinished offering for this grave, continue it
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

  /** Continue an offering found after a refresh / wallet redirect. */
  async resume(p: PaymentView, redirectTx: { hash: string; account: string | null } | null): Promise<void> {
    if (!p.grave) return;
    this.grave = p.grave; this.item = (p.item as OfferingItem) ?? 'candle';
    void this.loadConfig();
    this.amount = nearInput(p.amount);
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
    if (!/^\d{1,9}(\.\d{1,6})?$/.test(raw)) { this.amountError = 'Enter a NEAR amount, like 0.01 (up to 6 decimals).'; return null; }
    try { v = parseUnits(raw, 24); } catch { this.amountError = 'Enter a NEAR amount, like 0.01.'; return null; }
    const min = this.config.offeringMin;
    if (!min) { this.amountError = 'Could not get the NEAR price right now. Try again in a minute.'; return null; }
    if (v < BigInt(min)) { this.amountError = `The minimum offering is ${nearLabel(min)} (about $${this.config.offeringMinUsd}).`; return null; }
    this.amountError = null;
    return v;
  }

  private pay() {
    const g = this.grave, amt = this.validAmount();
    if (!g || amt === null) { this.render(); return; }
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

  /** One screen: pick an item, enter an amount, one button that connects the wallet and sends the offering. */
  private render() {
    const g = this.grave;
    if (!g) return;
    const title = document.getElementById('offer-title');
    if (title) title.textContent = `Leave an offering at $${g.meme.symbol}`;
    const F = this.flow.state;
    this.body.replaceChildren(graveSummary(g), F.s === 'done' ? this.renderDone(F.payment) : this.renderForm());
  }

  private memorialNote(): Node {
    const cfg = this.config, d = this.detail, acct = this.wallet.account;
    const off = cfg && !cfg.mintingEnabled ? " Minting isn't on yet; yours is saved until it is." : '';
    if (acct && d?.mine) {
      const m = d.mine;
      const which = m.status === 'minted' && m.serial ? ` #${String(m.serial).padStart(3, '0')}` : '';
      return h('p', { class: 'field-msg' }, `You already have this grave's Memorial NFT${which}.${off}`);
    }
    return h('p', { class: 'field-msg' }, `Your first offering here earns this grave's Memorial NFT.${off}`);
  }

  private renderForm() {
    const cfg = this.config;
    if (!cfg) {
      return h('div', { class: 'dlg-step' }, this.configError
        ? h('p', { class: 'status bad' }, `Could not load the offering details: ${this.configError}`)
        : h('p', { class: 'status busy' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Loading…'));
    }
    // while the wallet / NEAR is working, the choice is locked
    const editable = ['review', 'rejected', 'error', 'expired', 'insufficient'].includes(this.flow.state.s);
    const items = h('div', { class: 'items', role: 'radiogroup', 'aria-label': 'Offering' },
      ...OFFERING_ITEMS.map((it) => h('button', {
        class: 'item', type: 'button', role: 'radio', 'aria-checked': String(this.item === it.id), disabled: !editable,
        onclick: () => { this.item = it.id; this.render(); },
      }, itemArt(it.id), h('span', {}, it.name))));
    const input = h('input', {
      id: 'offer-amount', inputmode: 'decimal', autocomplete: 'off', value: this.amount, disabled: !editable,
      placeholder: cfg.offeringMin ? nearInput(cfg.offeringMin) : '0.01', 'aria-describedby': 'offer-amount-msg', 'aria-label': 'NEAR amount',
      oninput: (e: Event) => { this.amount = (e.target as HTMLInputElement).value; },
      onkeydown: (e: Event) => { if ((e as KeyboardEvent).key === 'Enter') { e.preventDefault(); this.pay(); } },
    });
    const quick = h('div', { class: 'quick' }, ...(cfg.nearUsd ? QUICK_USD : []).map((usd) => {
      const near = nearInput(usdToYocto(usd, cfg.nearUsd!));
      return h('button', { class: 'amt', type: 'button', disabled: !editable, title: `${near} NEAR`, onclick: () => { this.amount = near; this.amountError = null; this.render(); } },
        `$${Number(usd) < 1 ? usd.replace(/^0/, '') : usd}`);
    }));
    let amount = this.flow.payment?.amount ?? null;
    if (!amount && this.amount.trim()) { const v = this.validAmount(); amount = v === null ? null : v.toString(); }
    const price = amount ? nearLabel(amount) : 'NEAR';
    return h('div', { class: 'dlg-step' },
      items,
      h('div', { class: 'row amount-row' }, input, h('span', { class: 'unit' }, amount && cfg.nearUsd ? `NEAR · about ${usdLabel(amount, cfg.nearUsd)}` : 'NEAR')), quick,
      h('p', { id: 'offer-amount-msg', class: this.amountError ? 'field-msg bad' : 'field-msg' },
        this.amountError ?? (cfg.offeringMin ? `At least ${nearLabel(cfg.offeringMin)} (about $${cfg.offeringMinUsd}). Every offering counts as one.` : 'Could not get the NEAR price right now. Try again in a minute.')),
      this.memorialNote(),
      this.flow.view({
        price, decimals: cfg.decimals, solo: true,
        actionLabel: 'Leave offering', connectLabel: 'Connect wallet & leave offering',
        onAction: () => this.pay(), onClose: () => this.dlg.close(),
      }));
  }

  private renderDone(p: PaymentView) {
    const g = this.grave!, m = this.memorial, cfg = this.config;
    let nft: Node | null;
    if (!m) nft = null;
    else if (m.status === 'minted') {
      const link = cfg?.nftContract && m.tokenId
        ? h('a', { href: `https://nearblocks.io/nft-token/${cfg.nftContract}/${encodeURIComponent(m.tokenId)}`, target: '_blank', rel: 'noopener noreferrer' }, 'View')
        : null;
      nft = h('p', { class: 'field-msg' }, `$${g.meme.symbol} — Memorial #${String(m.serial ?? 0).padStart(3, '0')} is in your wallet. `, link);
    } else if (m.status === 'failed') {
      nft = h('p', { class: 'field-msg bad' }, m.error ?? 'Minting your Memorial NFT failed.');
    } else if (!cfg?.mintingEnabled) {
      nft = h('p', { class: 'field-msg' }, 'Your Memorial NFT is saved and will be minted to your wallet once minting switches on.');
    } else {
      nft = h('p', { class: 'field-msg busy-line' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Minting your Memorial NFT…');
    }
    return h('div', { class: 'dlg-step done' },
      h('p', { class: 'status ok' }, `Your ${itemName(p.item ?? '').toLowerCase()} was left at $${g.meme.symbol}.`),
      nft,
      h('div', { class: 'dlg-actions' }, h('button', { class: 'btn', type: 'button', onclick: () => this.dlg.close() }, 'R.I.P.')));
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
