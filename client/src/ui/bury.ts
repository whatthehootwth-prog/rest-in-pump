import {
  CHAINS, GRAVE_TIERS, MESSAGE_MAX, NEAR_ACCOUNT_RE, formatUnits, sanitizeMessage,
  type ChainId, type GraveInfo, type GraveTier, type MemeInfo, type PaymentView, type PriceConfig,
} from '../../../shared/graves.ts';
import { api, ApiError } from '../net/api.ts';
import { Wallet, WalletRejectedError } from '../wallet/wallet.ts';
import { h, shortAccount } from './dom.ts';

const PENDING_KEY = 'rip.pendingPayment';
const POLL_MS = 2500;
const POLL_FOR_MS = 120_000;

type Lookup =
  | { s: 'idle' } | { s: 'loading' } | { s: 'error'; msg: string }
  | { s: 'buried'; meme: MemeInfo; grave: GraveInfo } | { s: 'ok'; meme: MemeInfo };

type Pay =
  | { s: 'review' }
  | { s: 'connecting' }
  | { s: 'holding' }                                        // creating the reservation
  | { s: 'checking' }                                       // reading the WTH balance
  | { s: 'insufficient'; balance: string }
  | { s: 'approve' }                                        // waiting for the wallet
  | { s: 'confirming'; since: number }                      // tx sent, server verifying on NEAR
  | { s: 'slow' }                                           // still not final after a while
  | { s: 'rejected' }
  | { s: 'error'; msg: string; retry: boolean }
  | { s: 'unfulfillable'; msg: string }
  | { s: 'expired' }
  | { s: 'done'; grave: GraveInfo };

/**
 * "Bury a meme": contract → tombstone + message → pay in WTH → grave.
 * The pending payment id is kept in localStorage so a refresh (or a wallet redirect) can pick it up again.
 */
export class BuryDialog {
  private readonly dlg = document.getElementById('bury') as HTMLDialogElement;
  private readonly body = document.getElementById('bury-body') as HTMLElement;
  private readonly wallet: Wallet;
  private readonly toast: (t: string) => void;
  private config: PriceConfig | null = null;
  private plot = 0;
  private step: 'meme' | 'design' | 'pay' = 'meme';
  private chain: ChainId = 'near';
  private contract = '';
  private lookup: Lookup = { s: 'idle' };
  private tier: GraveTier = 2;
  private message = '';
  private pay: Pay = { s: 'review' };
  private payment: PaymentView | null = null;
  private timer: number | null = null;
  private polling = false;

  constructor(wallet: Wallet, toast: (t: string) => void) {
    this.wallet = wallet;
    this.toast = toast;
    document.getElementById('bury-close')!.addEventListener('click', () => this.dlg.close());
    this.dlg.addEventListener('close', () => this.stopTimer());
    wallet.onChange(() => { if (this.dlg.open) this.render(); });
  }

  /** Opens the dialog for an empty plot. */
  async open(plot: number): Promise<void> {
    // an unfinished payment for this plot? continue it instead of starting over
    if (this.payment && this.payment.plot === plot && (this.payment.status === 'pending' || this.payment.status === 'confirming')) {
      this.step = 'pay';
    } else if (this.plot !== plot || this.pay.s === 'done') {
      this.reset(plot);
    }
    this.dlg.showModal();
    this.render();
    if (!this.config) {
      try { this.config = await api.config(); this.render(); }
      catch (e) { this.lookup = { s: 'error', msg: (e as Error).message }; this.render(); }
    }
    if (this.step === 'meme') (this.body.querySelector('#bury-contract') as HTMLInputElement | null)?.focus();
  }

  /** After a refresh / wallet redirect: pick up an unfinished payment. */
  async recover(redirectTx: { hash: string; account: string | null } | null): Promise<void> {
    let id: string | null = null;
    try { id = localStorage.getItem(PENDING_KEY); } catch { /* storage blocked */ }
    if (!id) return;
    let p: PaymentView;
    try { p = await api.payment(id); } catch (e) {
      if (e instanceof ApiError && e.status === 404) this.forget();
      return;
    }
    this.adopt(p);
    if (p.status === 'fulfilled' && p.grave) { this.forget(); this.toast(`Your $${p.meme.symbol} grave #${p.plot} is ready.`); return; }
    if (p.status === 'unfulfillable') { this.forget(); this.reopen({ s: 'unfulfillable', msg: p.error ?? '' }); return; }
    if (p.status === 'failed' || p.status === 'expired') { this.forget(); return; }
    if (p.status === 'confirming') { this.toast('Still confirming your grave payment on NEAR…'); void this.poll(false); return; }
    // pending: came back from a wallet redirect with a tx hash, or the player left mid-way
    if (redirectTx) {
      const account = redirectTx.account ?? this.wallet.account;
      if (account) { this.reopen({ s: 'confirming', since: Date.now() }); await this.confirm(redirectTx.hash, account); return; }
    }
    this.reopen({ s: 'review' });
  }

  // ------------------------------------------------------------------ flow

  private reset(plot: number) {
    this.plot = plot;
    this.step = 'meme';
    this.lookup = { s: 'idle' };
    this.pay = { s: 'review' };
    this.payment = null;
    this.message = '';
    this.tier = 2;
    this.contract = '';
  }

  private reopen(pay: Pay) {
    this.step = 'pay';
    this.pay = pay;
    if (!this.dlg.open) this.dlg.showModal();
    if (!this.config) void api.config().then((c) => { this.config = c; this.render(); }).catch(() => {});
    this.render();
  }

  private adopt(p: PaymentView) {
    this.payment = p;
    this.plot = p.plot;
    this.chain = p.meme.chain;
    this.contract = p.meme.contract;
    this.lookup = { s: 'ok', meme: p.meme };
    this.tier = p.tier;
    this.message = p.message;
  }

  private async find() {
    const contract = this.contract.trim().toLowerCase();
    if (!NEAR_ACCOUNT_RE.test(contract)) { this.lookup = { s: 'error', msg: 'That does not look like a NEAR token contract address (e.g. token.example.near).' }; this.render(); return; }
    this.contract = contract;
    this.lookup = { s: 'loading' };
    this.render();
    try {
      const r = await api.meme(this.chain, contract);
      this.lookup = r.grave ? { s: 'buried', meme: r.meme, grave: r.grave } : { s: 'ok', meme: r.meme };
    } catch (e) {
      this.lookup = { s: 'error', msg: (e as Error).message };
    }
    this.render();
  }

  /** Pay button: connect → reserve → balance → wallet → confirm. */
  private async start() {
    if (!this.config || this.lookup.s !== 'ok') return;
    const message = sanitizeMessage(this.message);
    if (!message) { this.step = 'design'; this.render(); return; }
    let account = this.wallet.account;
    if (!account) {
      this.pay = { s: 'connecting' }; this.render();
      try { account = await this.wallet.connect(); }
      catch (e) { console.error('wallet connect failed', e); this.pay = { s: 'error', msg: 'The wallet could not be opened. Try again.', retry: true }; this.render(); return; }
      if (!account) { this.pay = { s: 'review' }; this.render(); return; }
    }
    // 1. reserve the plot + meme (or reuse our reservation)
    if (!this.payment || this.payment.status !== 'pending' || this.payment.expiresAt < Date.now()) {
      this.pay = { s: 'holding' }; this.render();
      try {
        this.payment = await api.createPayment({ plot: this.plot, chain: this.chain, contract: this.contract, tier: this.tier, message });
        this.remember(this.payment.id);
      } catch (e) {
        this.pay = { s: 'error', msg: (e as Error).message, retry: !(e instanceof ApiError) || e.status >= 500 || e.code === 'network' };
        this.render(); return;
      }
    }
    const p = this.payment;
    this.startTimer();
    // 2. enough WTH?
    this.pay = { s: 'checking' }; this.render();
    try {
      const { balance } = await api.balance(account);
      if (BigInt(balance) < BigInt(p.amount)) { this.pay = { s: 'insufficient', balance }; this.render(); return; }
    } catch { /* balance unknown: let the wallet decide rather than block the player */ }
    // 3. sign in the wallet
    this.pay = { s: 'approve' }; this.render();
    let hash: string;
    try {
      hash = await this.wallet.sendFtTransfer({ token: p.token, receiver: p.receiver, amount: p.amount, memo: p.memo });
    } catch (e) {
      if (e instanceof WalletRejectedError) this.pay = { s: 'rejected' };
      else this.pay = { s: 'error', msg: `The wallet reported a problem: ${(e as Error).message}`, retry: true };
      this.render(); return;
    }
    // 4. verify on NEAR + create the grave
    this.pay = { s: 'confirming', since: Date.now() }; this.render();
    await this.confirm(hash, account);
  }

  private async confirm(hash: string, account: string) {
    if (!this.payment) return;
    try {
      const v = await api.confirm(this.payment.id, hash, account);
      this.payment = v;
      this.afterStatus(v);
      if (v.status === 'confirming') void this.poll(true);
    } catch (e) {
      // the server may not have heard us: keep the tx hash shown, and the background check will catch up
      this.pay = { s: 'error', msg: `${(e as Error).message} Your transaction was sent (${hash.slice(0, 10)}…). Reopen this grave to check again.`, retry: false };
      this.render();
    }
  }

  private async poll(visible: boolean) {
    if (this.polling || !this.payment) return;
    this.polling = true;
    const until = Date.now() + POLL_FOR_MS;
    try {
      while (Date.now() < until && this.payment?.status === 'confirming') {
        await new Promise((r) => setTimeout(r, POLL_MS));
        try { this.payment = await api.payment(this.payment.id); } catch { continue; }
        if (this.payment.status !== 'confirming') { this.afterStatus(this.payment); return; }
      }
      if (this.payment?.status === 'confirming' && visible) { this.pay = { s: 'slow' }; this.render(); }
    } finally {
      this.polling = false;
    }
  }

  private afterStatus(v: PaymentView) {
    if (v.status === 'fulfilled' && v.grave) {
      this.forget(); this.stopTimer();
      this.pay = { s: 'done', grave: v.grave };
      if (!this.dlg.open) this.toast(`$${v.meme.symbol} now rests in grave #${v.plot}.`);
    } else if (v.status === 'unfulfillable') {
      this.forget(); this.pay = { s: 'unfulfillable', msg: v.error ?? '' };
    } else if (v.status === 'failed') {
      this.forget(); this.pay = { s: 'error', msg: v.error ?? 'The payment could not be verified.', retry: false };
    } else if (v.status === 'pending' && v.error) {
      this.pay = { s: 'error', msg: v.error, retry: true };   // wrong/underpaid tx: hold kept, try again
    } else if (v.status === 'expired') {
      this.pay = { s: 'expired' };
    } else if (v.status === 'confirming') {
      this.pay = { s: 'confirming', since: Date.now() };
    }
    this.render();
  }

  private async cancel() {
    const p = this.payment;
    this.stopTimer();
    if (p && p.status === 'pending') { try { await api.cancel(p.id); } catch { /* it expires on its own */ } }
    this.forget();
    this.payment = null;
    this.pay = { s: 'review' };
    this.dlg.close();
  }

  private startTimer() {
    this.stopTimer();
    this.timer = window.setInterval(() => {
      const left = this.payment ? this.payment.expiresAt - Date.now() : 0;
      const el = this.body.querySelector('#bury-hold');
      if (el) el.textContent = holdText(left);
      if (left <= 0 && this.payment?.status === 'pending' && ['review', 'insufficient', 'rejected', 'error'].includes(this.pay.s)) {
        this.stopTimer(); this.pay = { s: 'expired' }; this.render();
      }
    }, 1000);
  }
  private stopTimer() { if (this.timer !== null) clearInterval(this.timer); this.timer = null; }
  private remember(id: string) { try { localStorage.setItem(PENDING_KEY, id); } catch { /* not persisted */ } }
  private forget() { try { localStorage.removeItem(PENDING_KEY); } catch { /* ignore */ } }

  // ------------------------------------------------------------------ rendering

  private render() {
    const steps = h('ol', { class: 'steps', 'aria-label': 'Steps' },
      ...(['Meme', 'Tombstone', 'Pay'] as const).map((label, i) =>
        h('li', { class: ['meme', 'design', 'pay'].indexOf(this.step) === i ? 'on' : ['meme', 'design', 'pay'].indexOf(this.step) > i ? 'done' : '' }, label)));
    const title = document.getElementById('bury-title');
    if (title) title.textContent = `Bury a meme in grave #${this.plot}`;
    const view = this.step === 'meme' ? this.renderMeme() : this.step === 'design' ? this.renderDesign() : this.renderPay();
    this.body.replaceChildren(steps, view);
  }

  private memeChip(m: MemeInfo) {
    return h('div', { class: 'meme-chip' },
      m.icon ? h('img', { src: m.icon, alt: '' }) : h('div', { class: 'meme-ph' }, (m.symbol || '?').slice(0, 1).toUpperCase()),
      h('div', {}, h('b', {}, m.name), h('span', {}, ` $${m.symbol}`), h('div', { class: 'mono small muted' }, m.contract)));
  }

  private renderMeme() {
    const input = h('input', {
      id: 'bury-contract', value: this.contract, placeholder: 'token.example.near', spellcheck: 'false', autocomplete: 'off',
      'aria-label': 'Token contract address',
      oninput: (e: Event) => { this.contract = (e.target as HTMLInputElement).value; },
      onkeydown: (e: Event) => { if ((e as KeyboardEvent).key === 'Enter') { e.preventDefault(); void this.find(); } },
    });
    const chainSel = h('select', { id: 'bury-chain', 'aria-label': 'Chain', onchange: (e: Event) => { this.chain = (e.target as HTMLSelectElement).value as ChainId; } },
      ...CHAINS.map((c) => h('option', { value: c.id, disabled: !c.live, selected: c.id === this.chain }, c.live ? c.name : `${c.name} (coming soon)`)));
    const L = this.lookup;
    const result =
      L.s === 'loading' ? h('p', { class: 'field-msg' }, 'Looking it up on NEAR…')
      : L.s === 'error' ? h('p', { class: 'field-msg bad' }, L.msg)
      : L.s === 'buried' ? h('div', {}, this.memeChip(L.meme), h('p', { class: 'field-msg bad' }, `$${L.meme.symbol} is already buried in grave #${L.grave.plot}. Each meme gets one grave.`))
      : L.s === 'ok' ? h('div', {}, this.memeChip(L.meme), L.meme.icon ? null : h('p', { class: 'field-msg' }, 'This token has no logo we can show; its grave will use its first letter.'))
      : h('p', { class: 'field-msg' }, 'Paste the token contract. We read the name and logo straight from the chain.');
    return h('div', { class: 'bury-step' },
      h('label', { class: 'lbl', for: 'bury-contract' }, 'Meme token contract'),
      h('div', { class: 'row' }, chainSel, input, h('button', { class: 'btn', type: 'button', disabled: L.s === 'loading', onclick: () => void this.find() }, 'Find')),
      result,
      h('div', { class: 'bury-actions' },
        h('button', { class: 'btn', type: 'button', disabled: L.s !== 'ok', onclick: () => { this.step = 'design'; this.render(); } }, 'Next')));
  }

  private renderDesign() {
    const cfg = this.config;
    const cards = h('div', { class: 'tiers', role: 'radiogroup', 'aria-label': 'Tombstone' },
      ...GRAVE_TIERS.map((t) => h('button', {
        class: 'tier', type: 'button', role: 'radio', 'aria-checked': String(this.tier === t.tier),
        onclick: () => { this.tier = t.tier; this.render(); },
      },
      h('span', { class: `tier-art tier-art-${t.tier}`, 'aria-hidden': 'true' }),
      h('b', {}, t.name),
      h('span', { class: 'tier-usd' }, `$${t.usd} tier`),
      h('span', { class: 'tier-wth' }, cfg ? `${formatUnits(toUnitsStr(cfg.tiers[t.tier], cfg.decimals), cfg.decimals)} WTH` : '…'))));
    const len = [...this.message].length;
    const ta = h('textarea', {
      id: 'bury-msg', maxlength: MESSAGE_MAX, rows: 2, placeholder: 'Here lies my portfolio. It went to zero, as foretold.',
      'aria-describedby': 'bury-count',
      oninput: (e: Event) => { this.message = (e.target as HTMLTextAreaElement).value; const c = document.getElementById('bury-count'); if (c) c.textContent = `${[...this.message].length}/${MESSAGE_MAX}`; },
    });
    ta.value = this.message;
    const valid = !!sanitizeMessage(this.message);
    return h('div', { class: 'bury-step' },
      this.lookup.s === 'ok' ? this.memeChip(this.lookup.meme) : null,
      h('div', { class: 'lbl' }, 'Tombstone'), cards,
      h('p', { class: 'field-msg' }, 'Prices are fixed amounts of WTH for each tier.'),
      h('label', { class: 'lbl', for: 'bury-msg' }, 'Last words'), ta,
      h('p', { id: 'bury-count', class: 'field-msg' }, `${len}/${MESSAGE_MAX}`),
      h('div', { class: 'bury-actions' },
        h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => { this.step = 'meme'; this.render(); } }, 'Back'),
        h('button', { class: 'btn', type: 'button', onclick: () => { if (sanitizeMessage(this.message)) { this.step = 'pay'; this.render(); } else this.render(); } }, 'Review'),
      ),
      !valid && len > 0 ? h('p', { class: 'field-msg bad' }, 'Leave a message of 1–100 characters.') : null);
  }

  private renderPay() {
    const cfg = this.config, meme = this.lookup.s === 'ok' ? this.lookup.meme : null;
    const amount = this.payment?.amount ?? (cfg ? toUnitsStr(cfg.tiers[this.tier], cfg.decimals) : null);
    const price = amount && cfg ? `${formatUnits(amount, cfg.decimals)} WTH` : '…';
    const P = this.pay;
    const acct = this.wallet.account;
    const summary = h('dl', { class: 'summary' },
      h('dt', {}, 'Meme'), h('dd', {}, meme ? `${meme.name} ($${meme.symbol})` : '—'),
      h('dt', {}, 'Grave'), h('dd', {}, `#${this.plot} · ${GRAVE_TIERS[this.tier - 1].name}`),
      h('dt', {}, 'Last words'), h('dd', {}, `“${this.message}”`),
      h('dt', {}, 'Price'), h('dd', {}, h('b', {}, price)),
      h('dt', {}, 'Paid to'), h('dd', { class: 'mono' }, cfg?.receiver ?? '—'),
      h('dt', {}, 'Wallet'), h('dd', {}, acct ? shortAccount(acct) : 'not connected'));
    const holdLeft = this.payment && this.payment.status === 'pending' ? this.payment.expiresAt - Date.now() : 0;
    const hold = holdLeft > 0 ? h('p', { id: 'bury-hold', class: 'field-msg' }, holdText(holdLeft)) : null;
    const busy = (text: string) => h('p', { class: 'status busy', role: 'status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), text);
    const payBtn = (label: string) => h('button', { class: 'btn', type: 'button', onclick: () => void this.start() }, label);
    const cancelBtn = h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => void this.cancel() }, this.payment?.status === 'pending' ? 'Cancel reservation' : 'Close');
    const back = h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => { this.step = 'design'; this.render(); } }, 'Back');
    let status: Node | null = null, actions: Node[] = [];
    switch (P.s) {
      case 'review': actions = [back, payBtn(acct ? `Pay ${price}` : 'Connect wallet & pay')]; break;
      case 'connecting': status = busy('Opening your wallet…'); break;
      case 'holding': status = busy('Reserving this grave…'); break;
      case 'checking': status = busy('Checking your WTH balance…'); break;
      case 'insufficient':
        status = h('p', { class: 'status bad' }, `Not enough WTH. You have ${cfg ? formatUnits(P.balance, cfg.decimals) : P.balance} WTH and need ${price}.`);
        actions = [cancelBtn, payBtn('I topped up — try again')]; break;
      case 'approve': status = busy('Approve the WTH transfer in your wallet…'); break;
      case 'confirming': status = busy('Payment sent. Confirming it on NEAR…'); break;
      case 'slow':
        status = h('p', { class: 'status' }, 'NEAR is taking a while to confirm. You can close this — your grave appears as soon as the payment is confirmed, even if you refresh.');
        actions = [h('button', { class: 'btn', type: 'button', onclick: () => this.dlg.close() }, 'OK')]; break;
      case 'rejected':
        status = h('p', { class: 'status bad' }, 'You cancelled the transfer in your wallet. Nothing was sent.');
        actions = [cancelBtn, payBtn('Try again')]; break;
      case 'error':
        status = h('p', { class: 'status bad' }, P.msg);
        actions = P.retry ? [cancelBtn, payBtn('Try again')] : [h('button', { class: 'btn', type: 'button', onclick: () => this.dlg.close() }, 'Close')]; break;
      case 'expired':
        status = h('p', { class: 'status bad' }, 'Your reservation expired before payment. Nothing was charged.');
        actions = [cancelBtn, payBtn('Reserve again & pay')];
        this.payment = null; break;
      case 'unfulfillable':
        status = h('p', { class: 'status bad' }, `Your payment arrived, but the grave could not be created: ${P.msg} Contact support with your transaction hash for a refund.`);
        actions = [h('button', { class: 'btn', type: 'button', onclick: () => this.dlg.close() }, 'Close')]; break;
      case 'done':
        return h('div', { class: 'bury-step done' },
          meme ? this.memeChip(meme) : null,
          h('p', { class: 'status ok' }, `Buried. $${P.grave.meme.symbol} now rests in grave #${P.grave.plot}.`),
          h('div', { class: 'bury-actions' }, h('button', { class: 'btn', type: 'button', onclick: () => this.dlg.close() }, 'Pay respects')));
    }
    const tx = this.payment?.txHash ? h('p', { class: 'field-msg mono' }, 'Transaction: ',
      h('a', { href: `https://nearblocks.io/txns/${this.payment.txHash}`, target: '_blank', rel: 'noopener noreferrer' }, `${this.payment.txHash.slice(0, 12)}…`)) : null;
    return h('div', { class: 'bury-step' }, summary, hold, status, tx, h('div', { class: 'bury-actions' }, ...actions));
  }
}

function holdText(ms: number) {
  if (ms <= 0) return 'Reservation expired.';
  const s = Math.ceil(ms / 1000);
  return `Grave reserved for you: ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** "75000" whole WTH -> smallest-unit string (client copy of the server's exact conversion). */
function toUnitsStr(whole: string, decimals: number): string {
  const [i, f = ''] = whole.split('.');
  return (BigInt(i) * 10n ** BigInt(decimals) + BigInt((f.padEnd(decimals, '0') || '0').slice(0, decimals))).toString();
}
