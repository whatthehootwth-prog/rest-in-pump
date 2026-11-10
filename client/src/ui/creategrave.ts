import {
  CHAINS, GRAVE_LEVELS, MESSAGE_MAX, chainName, memeAddress, nearLabel, sanitizeMessage, usdLabel,
  type ChainId, type GraveInfo, type MemeInfo, type PaymentView, type PriceConfig,
} from '../../../shared/graves.ts';
import { api } from '../net/api.ts';
import type { Wallet } from '../wallet/wallet.ts';
import { h, shortAccount } from './dom.ts';
import { PayFlow } from './payflow.ts';

/** What the address field says for each chain that can have graves. */
const CHAIN_TEXT: Record<ChainId, { label: string; placeholder: string; hint: string; bad: string }> = {
  near: { label: 'Meme token contract', placeholder: 'token.example.near', hint: 'Paste the token contract. We read the name and logo straight from NEAR.', bad: 'That does not look like a NEAR token contract address (e.g. token.example.near).' },
  solana: { label: 'Meme token mint address', placeholder: 'e.g. DezXAZ8z7Pnrn…B263', hint: 'Paste the token mint address (the CA). We read the name and logo from Solana. You still pay in NEAR.', bad: 'That does not look like a Solana token address. It is 32 to 44 letters and numbers.' },
  base: { label: 'Token contract', placeholder: '', hint: 'Base memes are coming soon.', bad: 'Base memes are coming soon.' },
  ethereum: { label: 'Token contract', placeholder: '', hint: 'Ethereum memes are coming soon.', bad: 'Ethereum memes are coming soon.' },
};

type Lookup =
  | { s: 'idle' } | { s: 'loading' } | { s: 'error'; msg: string }
  | { s: 'exists'; meme: MemeInfo; grave: GraveInfo } | { s: 'ok'; meme: MemeInfo };

/**
 * "Create a grave": meme contract → last words → send the grave price in NEAR → a level-1 grave on the plot.
 * Creating a grave does not mint an NFT; memorials come from offerings (the creator can make one too).
 */
export class CreateGraveDialog {
  private readonly dlg = document.getElementById('grave-dlg') as HTMLDialogElement;
  private readonly body = document.getElementById('grave-body') as HTMLElement;
  private readonly wallet: Wallet;
  private readonly flow: PayFlow;
  private config: PriceConfig | null = null;
  private configError: string | null = null;
  private plot = 0;
  private step: 'meme' | 'words' | 'pay' = 'meme';
  private chain: ChainId = 'near';
  private contract = '';
  private lookup: Lookup = { s: 'idle' };
  private message = '';

  constructor(wallet: Wallet, toast: (t: string) => void) {
    this.wallet = wallet;
    this.flow = new PayFlow(wallet, {
      render: () => this.render(), isOpen: () => this.dlg.open, close: () => this.dlg.close(), toast,
      doneToast: (p) => `$${p.meme.symbol} now has a grave at plot #${p.plot}.`,
    }, 'grave');
    document.getElementById('grave-close')!.addEventListener('click', () => this.dlg.close());
    this.dlg.addEventListener('close', () => this.flow.stopTimer());
    wallet.onChange(() => { if (this.dlg.open) this.render(); });
  }

  /** Opens the dialog for an empty plot. */
  async open(plot: number): Promise<void> {
    if (this.flow.open && this.flow.payment?.plot === plot) this.step = 'pay';   // continue an unfinished payment
    else if (this.plot !== plot || this.flow.state.s === 'done') this.reset(plot);
    this.dlg.showModal();
    this.render();
    await this.loadConfig();
    if (this.step === 'meme') (this.body.querySelector('#grave-contract') as HTMLInputElement | null)?.focus();
  }

  /** Continue a grave payment found after a refresh / wallet redirect. */
  async resume(p: PaymentView, redirectTx: { hash: string; account: string | null } | null): Promise<void> {
    this.plot = p.plot; this.chain = p.meme.chain; this.contract = p.meme.contract;
    this.lookup = { s: 'ok', meme: p.meme }; this.message = p.message; this.step = 'pay';
    void this.loadConfig();
    await this.flow.resume(p, redirectTx);
    if (this.flow.state.s === 'confirming' && !redirectTx) return;   // finishes in the background; toast when done
    if (!this.dlg.open) this.dlg.showModal();
    this.render();
  }

  private async loadConfig() {
    if (this.config) return;
    try { this.config = await api.config(); this.configError = null; }
    catch (e) { this.configError = (e as Error).message; }
    this.render();
  }

  private reset(plot: number) {
    this.flow.reset();
    this.plot = plot; this.step = 'meme'; this.lookup = { s: 'idle' }; this.message = ''; this.contract = '';
  }

  private async find() {
    const contract = memeAddress(this.chain, this.contract);
    if (!contract) { this.lookup = { s: 'error', msg: CHAIN_TEXT[this.chain].bad }; this.render(); return; }
    this.contract = contract;
    this.lookup = { s: 'loading' };
    this.render();
    try {
      const r = await api.meme(this.chain, contract);
      this.lookup = r.grave ? { s: 'exists', meme: r.meme, grave: r.grave } : { s: 'ok', meme: r.meme };
    } catch (e) {
      this.lookup = { s: 'error', msg: (e as Error).message };
    }
    this.render();
  }

  private pay() {
    const message = sanitizeMessage(this.message);
    if (!message || this.lookup.s !== 'ok') { this.step = 'words'; this.render(); return; }
    void this.flow.start(
      () => api.createGrave({ plot: this.plot, chain: this.chain, contract: this.contract, message }),
      (p) => p.kind === 'grave' && p.plot === this.plot && p.meme.contract === this.contract && p.message === message,
    );
  }

  // ------------------------------------------------------------------ rendering

  private render() {
    const order = ['meme', 'words', 'pay'] as const;
    const steps = h('ol', { class: 'steps', 'aria-label': 'Steps' },
      ...(['Pick the coin', 'Last words', 'Bury it'] as const).map((label, i) =>
        h('li', { class: order.indexOf(this.step) === i ? 'on' : order.indexOf(this.step) > i ? 'done' : '' }, h('span', { class: 'n', 'aria-hidden': 'true' }, String(i + 1)), h('span', { class: 't' }, label))));
    const title = document.getElementById('grave-title');
    if (title) title.textContent = `Dig a grave · plot #${this.plot}`;
    const view = this.step === 'meme' ? this.renderMeme() : this.step === 'words' ? this.renderWords() : this.renderPay();
    this.body.replaceChildren(steps, view);
  }

  private renderMeme() {
    const input = h('input', {
      id: 'grave-contract', value: this.contract, placeholder: CHAIN_TEXT[this.chain].placeholder, spellcheck: 'false', autocomplete: 'off',
      'aria-label': CHAIN_TEXT[this.chain].label,
      oninput: (e: Event) => { this.contract = (e.target as HTMLInputElement).value; },
      onkeydown: (e: Event) => { if ((e as KeyboardEvent).key === 'Enter') { e.preventDefault(); void this.find(); } },
    });
    const chainSel = h('select', { 'aria-label': 'Chain', onchange: (e: Event) => { this.chain = (e.target as HTMLSelectElement).value as ChainId; this.lookup = { s: 'idle' }; this.render(); } },
      ...CHAINS.map((c) => h('option', { value: c.id, disabled: !c.live, selected: c.id === this.chain }, c.live ? c.name : `${c.name} (coming soon)`)));
    const L = this.lookup;
    const result =
      L.s === 'loading' ? h('p', { class: 'field-msg' }, `Looking it up on ${chainName(this.chain)}…`)
      : L.s === 'error' ? h('p', { class: 'field-msg bad' }, L.msg)
      : L.s === 'exists' ? h('div', {}, memeChip(L.meme), h('p', { class: 'field-msg bad' }, `$${L.meme.symbol} already has a grave at plot #${L.grave.plot}. Each coin gets one grave, so go leave a gift there.`))
      : L.s === 'ok' ? h('div', {}, memeChip(L.meme), L.meme.icon ? null : h('p', { class: 'field-msg' }, 'This token has no logo we can show; its grave will use its first letter.'))
      : h('p', { class: 'field-msg' }, CHAIN_TEXT[this.chain].hint);
    return h('div', { class: 'dlg-step' },
      h('label', { class: 'lbl', for: 'grave-contract' }, CHAIN_TEXT[this.chain].label),
      h('div', { class: 'row' }, chainSel, input, h('button', { class: 'btn', type: 'button', disabled: L.s === 'loading', onclick: () => void this.find() }, 'Find')),
      result,
      h('div', { class: 'dlg-actions' },
        h('button', { class: 'btn btn-go', type: 'button', disabled: L.s !== 'ok', onclick: () => { this.step = 'words'; this.render(); } }, 'Next')));
  }

  private renderWords() {
    const len = [...this.message].length;
    const ta = h('textarea', {
      id: 'grave-msg', maxlength: MESSAGE_MAX, rows: 2, placeholder: 'Here lies my portfolio. It went to zero, as foretold.',
      'aria-describedby': 'grave-count',
      oninput: (e: Event) => { this.message = (e.target as HTMLTextAreaElement).value; const c = document.getElementById('grave-count'); if (c) c.textContent = `${[...this.message].length}/${MESSAGE_MAX}`; },
    });
    ta.value = this.message;
    const valid = !!sanitizeMessage(this.message);
    return h('div', { class: 'dlg-step' },
      h('label', { class: 'lbl', for: 'grave-msg' }, 'Carve its last words'),
      h('div', { class: 'slab' },
        h('div', { class: 'slab-rip', 'aria-hidden': 'true' }, 'R.I.P.'),
        this.lookup.s === 'ok' ? h('div', { class: 'slab-name', 'aria-hidden': 'true' }, `$${this.lookup.meme.symbol}`) : null,
        ta,
        h('p', { id: 'grave-count', class: 'slab-count' }, `${len}/${MESSAGE_MAX}`)),
      h('p', { class: 'field-msg' },
        `Every grave starts as a ${GRAVE_LEVELS[0].name}. Each offering visitors leave adds one to its count, and it grows at ${GRAVE_LEVELS[1].min}, ${GRAVE_LEVELS[2].min} and ${GRAVE_LEVELS[3].min.toLocaleString('en-US')} offerings.`),
      h('div', { class: 'dlg-actions' },
        h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => { this.step = 'meme'; this.render(); } }, 'Back'),
        h('button', { class: 'btn btn-go', type: 'button', onclick: () => { if (sanitizeMessage(this.message)) this.step = 'pay'; this.render(); } }, 'Next')),
      !valid && len > 0 ? h('p', { class: 'field-msg bad' }, 'Leave a message of 1–100 characters.') : null);
  }

  private renderPay() {
    const cfg = this.config, meme = this.lookup.s === 'ok' ? this.lookup.meme : null;
    const F = this.flow.state;
    if (F.s === 'done') {
      const g = F.payment.grave;
      return h('div', { class: 'dlg-step done' },
        h('div', { class: 'celebrate' }, h('div', { class: 'cele-art' }, tombArt(meme)), h('p', { class: 'cele-title' }, 'Buried!'),
          h('p', { class: 'cele-sub' }, g ? `$${g.meme.symbol} now rests at plot #${g.plot}.` : 'Your grave is ready.')),
        h('p', { class: 'field-msg' }, 'Now invite the mourners. Anyone who leaves a gift here, you included, gets this grave\'s Memorial NFT with their first one.'),
        h('div', { class: 'dlg-actions' }, h('button', { class: 'btn btn-go', type: 'button', onclick: () => this.dlg.close() }, 'R.I.P.')));
    }
    if (!cfg) {
      return h('div', { class: 'dlg-step' }, this.configError
        ? h('p', { class: 'status bad' }, `Could not load prices: ${this.configError}`)
        : h('p', { class: 'status busy' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Loading prices…'));
    }
    const amount = this.flow.payment?.amount ?? cfg.gravePrice;
    if (!amount || !cfg.nearUsd) {
      return h('div', { class: 'dlg-step' }, h('p', { class: 'status bad' }, 'Could not get the NEAR price right now, so graves are paused for a moment. Try again in a minute.'));
    }
    const price = nearLabel(amount);
    const acct = this.wallet.account;
    // a preview of the grave about to be made, with the price on a tag
    const summary = h('div', { class: 'preview' },
      tombArt(meme),
      h('div', { class: 'preview-txt' },
        h('b', {}, meme ? `${meme.name} $${meme.symbol}` : 'Your coin'),
        h('p', { class: 'preview-words' }, `“${this.message}”`),
        h('p', { class: 'preview-meta' }, `Plot #${this.plot} · goes to `, h('span', { class: 'mono' }, cfg.receiver)),
        h('p', { class: 'preview-meta' }, `Wallet: ${acct ? shortAccount(acct) : 'not connected yet'}`),
        h('div', { class: 'price-tag' }, h('b', {}, price), h('span', {}, `≈ ${usdLabel(amount, cfg.nearUsd)}`))));
    return h('div', { class: 'dlg-step' }, summary,
      this.flow.view({
        price, decimals: cfg.decimals, actionLabel: `Bury it · ${price}`, connectLabel: 'Connect wallet & bury it',
        onAction: () => this.pay(), onClose: () => this.dlg.close(),
        back: () => { this.step = 'words'; this.render(); },
      }));
  }
}

/** A little tombstone with the coin's logo (or first letter) on it, for the "Buried!" screen. */
function tombArt(m: MemeInfo | null) {
  return h('div', { class: 'tomb' },
    m?.icon ? h('img', { src: m.icon, alt: '' }) : h('div', { class: 'meme-ph' }, (m?.symbol || '?').slice(0, 1).toUpperCase()),
    h('span', {}, 'R.I.P.'));
}

export function memeChip(m: MemeInfo) {
  return h('div', { class: 'meme-chip' },
    m.icon ? h('img', { src: m.icon, alt: '' }) : h('div', { class: 'meme-ph' }, (m.symbol || '?').slice(0, 1).toUpperCase()),
    h('div', { class: 'meme-txt' }, h('b', {}, m.name), h('span', { class: 'tick' }, `$${m.symbol}`), h('div', { class: 'mono small muted' }, `${chainName(m.chain)} · ${m.contract}`)));
}
