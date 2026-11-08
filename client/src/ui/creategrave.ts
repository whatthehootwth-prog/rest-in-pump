import {
  CHAINS, GRAVE_LEVELS, MESSAGE_MAX, NEAR_ACCOUNT_RE, formatUnits, parseUnits, sanitizeMessage,
  type ChainId, type GraveInfo, type MemeInfo, type PaymentView, type PriceConfig,
} from '../../../shared/graves.ts';
import { api } from '../net/api.ts';
import type { Wallet } from '../wallet/wallet.ts';
import { h, shortAccount } from './dom.ts';
import { PayFlow } from './payflow.ts';

type Lookup =
  | { s: 'idle' } | { s: 'loading' } | { s: 'error'; msg: string }
  | { s: 'exists'; meme: MemeInfo; grave: GraveInfo } | { s: 'ok'; meme: MemeInfo };

/**
 * "Create a grave": meme contract → last words → send the grave price in WTH → a level-1 grave on the plot.
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
    const contract = this.contract.trim().toLowerCase();
    if (!NEAR_ACCOUNT_RE.test(contract)) { this.lookup = { s: 'error', msg: 'That does not look like a NEAR token contract address (e.g. token.example.near).' }; this.render(); return; }
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
      ...(['Meme', 'Last words', 'Confirm'] as const).map((label, i) =>
        h('li', { class: order.indexOf(this.step) === i ? 'on' : order.indexOf(this.step) > i ? 'done' : '' }, label)));
    const title = document.getElementById('grave-title');
    if (title) title.textContent = `Create a grave at plot #${this.plot}`;
    const view = this.step === 'meme' ? this.renderMeme() : this.step === 'words' ? this.renderWords() : this.renderPay();
    this.body.replaceChildren(steps, view);
  }

  private renderMeme() {
    const input = h('input', {
      id: 'grave-contract', value: this.contract, placeholder: 'token.example.near', spellcheck: 'false', autocomplete: 'off',
      'aria-label': 'Token contract address',
      oninput: (e: Event) => { this.contract = (e.target as HTMLInputElement).value; },
      onkeydown: (e: Event) => { if ((e as KeyboardEvent).key === 'Enter') { e.preventDefault(); void this.find(); } },
    });
    const chainSel = h('select', { 'aria-label': 'Chain', onchange: (e: Event) => { this.chain = (e.target as HTMLSelectElement).value as ChainId; } },
      ...CHAINS.map((c) => h('option', { value: c.id, disabled: !c.live, selected: c.id === this.chain }, c.live ? c.name : `${c.name} (coming soon)`)));
    const L = this.lookup;
    const result =
      L.s === 'loading' ? h('p', { class: 'field-msg' }, 'Looking it up on NEAR…')
      : L.s === 'error' ? h('p', { class: 'field-msg bad' }, L.msg)
      : L.s === 'exists' ? h('div', {}, memeChip(L.meme), h('p', { class: 'field-msg bad' }, `$${L.meme.symbol} already has a grave at plot #${L.grave.plot}. Each meme gets one grave — go leave an offering there.`))
      : L.s === 'ok' ? h('div', {}, memeChip(L.meme), L.meme.icon ? null : h('p', { class: 'field-msg' }, 'This token has no logo we can show; its grave will use its first letter.'))
      : h('p', { class: 'field-msg' }, 'Paste the token contract. We read the name and logo straight from the chain.');
    return h('div', { class: 'dlg-step' },
      h('label', { class: 'lbl', for: 'grave-contract' }, 'Meme token contract'),
      h('div', { class: 'row' }, chainSel, input, h('button', { class: 'btn', type: 'button', disabled: L.s === 'loading', onclick: () => void this.find() }, 'Find')),
      result,
      h('div', { class: 'dlg-actions' },
        h('button', { class: 'btn', type: 'button', disabled: L.s !== 'ok', onclick: () => { this.step = 'words'; this.render(); } }, 'Next')));
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
      this.lookup.s === 'ok' ? memeChip(this.lookup.meme) : null,
      h('label', { class: 'lbl', for: 'grave-msg' }, 'Last words'), ta,
      h('p', { id: 'grave-count', class: 'field-msg' }, `${len}/${MESSAGE_MAX}`),
      h('p', { class: 'field-msg' },
        `Every grave starts as a ${GRAVE_LEVELS[0].name}. Each offering visitors leave adds one to its count, and it grows at ${GRAVE_LEVELS[1].min}, ${GRAVE_LEVELS[2].min} and ${GRAVE_LEVELS[3].min.toLocaleString('en-US')} offerings.`),
      h('div', { class: 'dlg-actions' },
        h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => { this.step = 'meme'; this.render(); } }, 'Back'),
        h('button', { class: 'btn', type: 'button', onclick: () => { if (sanitizeMessage(this.message)) this.step = 'pay'; this.render(); } }, 'Review')),
      !valid && len > 0 ? h('p', { class: 'field-msg bad' }, 'Leave a message of 1–100 characters.') : null);
  }

  private renderPay() {
    const cfg = this.config, meme = this.lookup.s === 'ok' ? this.lookup.meme : null;
    const F = this.flow.state;
    if (F.s === 'done') {
      const g = F.payment.grave;
      return h('div', { class: 'dlg-step done' },
        meme ? memeChip(meme) : null,
        h('p', { class: 'status ok' }, g ? `Done. $${g.meme.symbol} now has a grave at plot #${g.plot}.` : 'Done.'),
        h('p', { class: 'field-msg' }, 'Creating a grave does not mint an NFT. Anyone who leaves an offering here — you included — gets this grave\'s Memorial NFT with their first offering.'),
        h('div', { class: 'dlg-actions' }, h('button', { class: 'btn', type: 'button', onclick: () => this.dlg.close() }, 'Done')));
    }
    if (!cfg) {
      return h('div', { class: 'dlg-step' }, this.configError
        ? h('p', { class: 'status bad' }, `Could not load prices: ${this.configError}`)
        : h('p', { class: 'status busy' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Loading prices…'));
    }
    const amount = this.flow.payment?.amount ?? parseUnits(cfg.gravePrice, cfg.decimals).toString();
    const price = `${formatUnits(amount, cfg.decimals)} WTH`;
    const acct = this.wallet.account;
    const summary = h('dl', { class: 'summary' },
      h('dt', {}, 'Meme'), h('dd', {}, meme ? `${meme.name} ($${meme.symbol})` : '—'),
      h('dt', {}, 'Plot'), h('dd', {}, `#${this.plot}`),
      h('dt', {}, 'Last words'), h('dd', {}, `“${this.message}”`),
      h('dt', {}, 'Price'), h('dd', {}, h('b', {}, price)),
      h('dt', {}, 'Goes to'), h('dd', { class: 'mono' }, cfg.receiver),
      h('dt', {}, 'Wallet'), h('dd', {}, acct ? shortAccount(acct) : 'not connected'));
    return h('div', { class: 'dlg-step' }, summary,
      this.flow.view({
        price, decimals: cfg.decimals, actionLabel: `Create grave · ${price}`, connectLabel: 'Connect wallet & create grave',
        onAction: () => this.pay(), onClose: () => this.dlg.close(),
        back: () => { this.step = 'words'; this.render(); },
      }));
  }
}

export function memeChip(m: MemeInfo) {
  return h('div', { class: 'meme-chip' },
    m.icon ? h('img', { src: m.icon, alt: '' }) : h('div', { class: 'meme-ph' }, (m.symbol || '?').slice(0, 1).toUpperCase()),
    h('div', {}, h('b', {}, m.name), h('span', {}, ` $${m.symbol}`), h('div', { class: 'mono small muted' }, m.contract)));
}
