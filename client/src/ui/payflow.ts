import { nearLabel, type PaymentView } from '../../../shared/graves.ts';
import { api, ApiError } from '../net/api.ts';
import { Wallet, WalletRejectedError } from '../wallet/wallet.ts';
import { h } from './dom.ts';

/**
 * The NEAR transfer flow shared by "create a grave" and "leave an offering":
 * connect wallet → create the order on the server → check balance → sign the transfer → server verifies on NEAR.
 * The open order id is kept in localStorage so a refresh or a wallet redirect can finish it.
 * (User-facing text avoids "pay"/"payment" on purpose: it should feel like a game, not a checkout.)
 */

const PENDING_KEY = 'rip.pendingPayment';
const POLL_MS = 2500;
const POLL_FOR_MS = 120_000;

export type PayState =
  | { s: 'review' }
  | { s: 'connecting' }
  | { s: 'holding' }                                        // creating the payment on the server
  | { s: 'checking' }                                       // reading the NEAR balance
  | { s: 'insufficient'; balance: string }
  | { s: 'approve' }                                        // waiting for the wallet
  | { s: 'confirming'; since: number }                      // tx sent, server verifying on NEAR
  | { s: 'slow' }                                           // still not final after a while
  | { s: 'rejected' }
  | { s: 'error'; msg: string; retry: boolean }
  | { s: 'unfulfillable'; msg: string }
  | { s: 'expired' }
  | { s: 'done'; payment: PaymentView };

export interface PayHost {
  render(): void;
  isOpen(): boolean;
  close(): void;
  toast(t: string): void;
  /** Toast shown when an order completes while the dialog is closed. */
  doneToast(p: PaymentView): string;
}

export const pendingPayment = {
  get(): string | null { try { return localStorage.getItem(PENDING_KEY); } catch { return null; } },
  set(id: string) { try { localStorage.setItem(PENDING_KEY, id); } catch { /* not persisted */ } },
  clear() { try { localStorage.removeItem(PENDING_KEY); } catch { /* ignore */ } },
};

export class PayFlow {
  state: PayState = { s: 'review' };
  payment: PaymentView | null = null;
  private timer: number | null = null;
  private polling = false;
  private readonly wallet: Wallet;
  private readonly host: PayHost;
  private readonly noun: 'grave' | 'offering';

  constructor(wallet: Wallet, host: PayHost, noun: 'grave' | 'offering') {
    this.wallet = wallet;
    this.host = host;
    this.noun = noun;
  }

  reset() { this.stopTimer(); this.state = { s: 'review' }; this.payment = null; }
  get open(): boolean { return !!this.payment && (this.payment.status === 'pending' || this.payment.status === 'confirming'); }

  /** Main button. `create` makes (or resumes) the order on the server. */
  async start(create: () => Promise<PaymentView>, reuse: (p: PaymentView) => boolean): Promise<void> {
    let account = this.wallet.account;
    if (!account) {
      this.set({ s: 'connecting' });
      try { account = await this.wallet.connect(); }
      catch (e) { console.error('wallet connect failed', e); this.set({ s: 'error', msg: 'The wallet could not be opened. Try again.', retry: true }); return; }
      if (!account) { this.set({ s: 'review' }); return; }
    }
    if (!this.payment || this.payment.status !== 'pending' || this.payment.expiresAt < Date.now() || !reuse(this.payment)) {
      this.set({ s: 'holding' });
      try {
        this.payment = await create();
        pendingPayment.set(this.payment.id);
      } catch (e) {
        this.set({ s: 'error', msg: (e as Error).message, retry: !(e instanceof ApiError) || e.status >= 500 || e.code === 'network' });
        return;
      }
    }
    const p = this.payment;
    this.startTimer();
    this.set({ s: 'checking' });
    try {
      const { balance } = await api.balance(account);
      if (BigInt(balance) < BigInt(p.amount)) { this.set({ s: 'insufficient', balance }); return; }
    } catch { /* balance unknown: let the wallet decide rather than block the player */ }
    this.set({ s: 'approve' });
    let hash: string;
    try {
      hash = await this.wallet.sendNear({ receiver: p.receiver, amount: p.amount });
    } catch (e) {
      if (e instanceof WalletRejectedError) this.set({ s: 'rejected' });
      else this.set({ s: 'error', msg: `The wallet reported a problem: ${(e as Error).message}`, retry: true });
      return;
    }
    this.set({ s: 'confirming', since: Date.now() });
    await this.confirm(hash, account);
  }

  /** Continue an order found after a refresh / wallet redirect. */
  async resume(p: PaymentView, redirectTx: { hash: string; account: string | null } | null): Promise<void> {
    this.payment = p;
    if (p.status === 'confirming') { this.state = { s: 'confirming', since: Date.now() }; void this.poll(false); return; }
    if (p.status === 'pending' && redirectTx) {
      const account = redirectTx.account ?? this.wallet.account;
      if (account) { this.set({ s: 'confirming', since: Date.now() }); await this.confirm(redirectTx.hash, account); return; }
    }
    if (p.status === 'pending') { this.startTimer(); this.set({ s: 'review' }); return; }
    this.afterStatus(p);
  }

  async cancel(): Promise<void> {
    const p = this.payment;
    this.stopTimer();
    if (p && p.status === 'pending' && !p.txHash) { try { await api.cancel(p.id); } catch { /* it expires on its own */ } }
    pendingPayment.clear();
    this.payment = null;
    this.state = { s: 'review' };
  }

  stopTimer() { if (this.timer !== null) clearInterval(this.timer); this.timer = null; }

  private set(s: PayState) { this.state = s; this.host.render(); }

  private async confirm(hash: string, account: string) {
    if (!this.payment) return;
    try {
      const v = await api.confirm(this.payment.id, hash, account);
      this.payment = v;
      this.afterStatus(v);
      if (v.status === 'confirming') void this.poll(true);
    } catch (e) {
      // the server may not have heard us: keep the tx hash shown, the background check will catch up
      this.set({ s: 'error', msg: `${(e as Error).message} Your transaction was sent (${hash.slice(0, 10)}…). Reopen this to check again.`, retry: false });
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
      if (this.payment?.status === 'confirming' && visible) this.set({ s: 'slow' });
    } finally {
      this.polling = false;
    }
  }

  private afterStatus(v: PaymentView) {
    if (v.status === 'fulfilled') {
      pendingPayment.clear(); this.stopTimer();
      this.state = { s: 'done', payment: v };
      if (!this.host.isOpen()) this.host.toast(this.host.doneToast(v));
    } else if (v.status === 'unfulfillable') {
      pendingPayment.clear(); this.state = { s: 'unfulfillable', msg: v.error ?? '' };
    } else if (v.status === 'failed') {
      pendingPayment.clear(); this.state = { s: 'error', msg: v.error ?? 'The transfer could not be verified on NEAR.', retry: false };
    } else if (v.status === 'pending' && v.error) {
      this.state = { s: 'error', msg: v.error, retry: true };   // wrong/underpaid tx: try again
    } else if (v.status === 'expired') {
      pendingPayment.clear(); this.state = { s: 'expired' };
    } else if (v.status === 'confirming') {
      this.state = { s: 'confirming', since: Date.now() };
    }
    this.host.render();
  }

  private startTimer() {
    this.stopTimer();
    this.timer = window.setInterval(() => {
      const left = this.payment ? this.payment.expiresAt - Date.now() : 0;
      const el = document.getElementById(`hold-${this.noun}`);
      if (el) el.textContent = this.holdText(left);
      if (left <= 0 && this.payment?.status === 'pending' && ['review', 'insufficient', 'rejected', 'error'].includes(this.state.s)) {
        this.stopTimer(); this.set({ s: 'expired' });
      }
    }, 1000);
  }

  private holdText(ms: number) {
    if (ms <= 0) return this.noun === 'grave' ? 'Reservation expired.' : 'This offering expired.';
    const s = Math.ceil(ms / 1000), t = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    return this.noun === 'grave' ? `Plot reserved for you: ${t}` : `Offering open for ${t}`;
  }

  /** Status line, hold timer, tx link and buttons for the current state. Returns null for 'done' (the dialog renders that). */
  view(o: {
    price: string; decimals: number; back?: () => void;
    /** Main button label with a wallet connected, and without one. */
    actionLabel: string; connectLabel: string;
    /** Only the main button while reviewing (no Back / Cancel). */
    solo?: boolean;
    onAction: () => void; onClose: () => void;
  }): Node | null {
    const P = this.state;
    if (P.s === 'done') return null;
    const busy = (text: string) => h('p', { class: 'status busy', role: 'status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), text);
    const btn = (label: string, fn: () => void, quiet = false) => h('button', { class: quiet ? 'btn btn-quiet' : 'btn', type: 'button', onclick: fn }, label);
    const act = (label: string) => btn(label, o.onAction);
    const close = btn('Close', o.onClose);
    const cancel = btn(this.payment?.status === 'pending' ? (this.noun === 'grave' ? 'Cancel reservation' : 'Cancel') : 'Close',
      () => void this.cancel().then(o.onClose), true);
    let status: Node | null = null, actions: Node[] = [];
    switch (P.s) {
      case 'review': {
        const main = act(this.wallet.account ? o.actionLabel : o.connectLabel);
        actions = o.solo ? [main] : [o.back ? btn('Back', o.back, true) : cancel, main];
        break;
      }
      case 'connecting': status = busy('Opening your wallet…'); break;
      case 'holding': status = busy(this.noun === 'grave' ? 'Reserving this plot…' : 'Preparing your offering…'); break;
      case 'checking': status = busy('Checking your NEAR balance…'); break;
      case 'insufficient':
        status = h('p', { class: 'status bad' }, `Not enough NEAR. You have ${nearLabel(P.balance)} and need ${o.price} (plus a little for the network fee).`);
        actions = [cancel, act('I topped up — try again')]; break;
      case 'approve': status = busy('Approve the NEAR transfer in your wallet…'); break;
      case 'confirming': status = busy('Sent. Confirming it on NEAR…'); break;
      case 'slow':
        status = h('p', { class: 'status' }, `NEAR is taking a while to confirm. You can close this — your ${this.noun} counts as soon as NEAR confirms it, even if you refresh.`);
        actions = [close]; break;
      case 'rejected':
        status = h('p', { class: 'status bad' }, 'You cancelled the transfer in your wallet. Nothing was sent.');
        actions = [cancel, act('Try again')]; break;
      case 'error':
        status = h('p', { class: 'status bad' }, P.msg);
        actions = P.retry ? [cancel, act('Try again')] : [close]; break;
      case 'expired':
        status = h('p', { class: 'status bad' }, `${this.noun === 'grave' ? 'Your reservation' : 'This offering'} expired before it was sent. Nothing was charged.`);
        actions = [btn('Close', () => void this.cancel().then(o.onClose), true), act('Start again')];
        this.payment = null; break;
      case 'unfulfillable':
        status = h('p', { class: 'status bad' }, `Your NEAR arrived, but the ${this.noun} could not be ${this.noun === 'grave' ? 'created' : 'recorded'}: ${P.msg} Contact support with your transaction hash for a refund.`);
        actions = [close]; break;
    }
    const left = this.payment && this.payment.status === 'pending' ? this.payment.expiresAt - Date.now() : 0;
    const hold = left > 0 ? h('p', { id: `hold-${this.noun}`, class: 'field-msg' }, this.holdText(left)) : null;
    return h('div', {}, hold, status, txLink(this.payment?.txHash ?? null), h('div', { class: 'dlg-actions' }, ...actions));
  }
}

export function txLink(hash: string | null): Node | null {
  return hash ? h('p', { class: 'field-msg mono' }, 'Transaction: ',
    h('a', { href: `https://nearblocks.io/txns/${hash}`, target: '_blank', rel: 'noopener noreferrer' }, `${hash.slice(0, 12)}…`)) : null;
}
