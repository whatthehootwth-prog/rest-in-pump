/**
 * NEAR wallet connection via NEAR Wallet Selector (MyNearWallet, Meteor, HERE, Intear).
 * The wallet code is large, so it is only downloaded when the player needs it (connect / pay),
 * or on load if they were already connected in this browser.
 */
import type { WalletSelector } from '@near-wallet-selector/core';
import type { WalletSelectorModal } from '@near-wallet-selector/modal-ui';

export class WalletRejectedError extends Error {}

type Loaded = { selector: WalletSelector; modal: WalletSelectorModal; actions: typeof import('@near-js/transactions').actionCreators };
const SELECTED_KEY = 'near-wallet-selector:selectedWalletId';

export class Wallet {
  account: string | null = null;
  private loaded: Promise<Loaded> | null = null;
  private readonly listeners = new Set<(account: string | null) => void>();

  onChange(fn: (account: string | null) => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  /** Restores a previous connection without loading wallet code for people who never connected. */
  async restore(): Promise<void> {
    let had = false;
    try { had = !!localStorage.getItem(SELECTED_KEY); } catch { /* storage blocked */ }
    if (had) await this.load().catch(() => {});
  }

  /** Opens the wallet picker. Resolves with the account, or null if the player closed it. */
  async connect(): Promise<string | null> {
    const { modal } = await this.load();
    if (this.account) return this.account;
    return new Promise((resolve) => {
      const offAcc = this.onChange((a) => { if (a) { offAcc(); sub.remove(); resolve(a); } });
      const sub = modal.on('onHide', ({ hideReason }) => {
        if (hideReason === 'user-triggered') { offAcc(); sub.remove(); resolve(this.account); }
      });
      modal.show();
    });
  }

  async disconnect(): Promise<void> {
    if (!this.loaded) return;
    const { selector } = await this.loaded;
    try { await (await selector.wallet()).signOut(); } catch { /* already signed out */ }
    this.set(null);
  }

  /** Sends an NEP-141 ft_transfer (1 yoctoNEAR deposit, as the standard requires). Returns the tx hash. */
  async sendFtTransfer(p: { token: string; receiver: string; amount: string; memo: string }): Promise<string> {
    const { selector, actions } = await this.load();
    const wallet = await selector.wallet();
    let outcome: unknown;
    try {
      outcome = await wallet.signAndSendTransaction({
        receiverId: p.token,
        actions: [actions.functionCall('ft_transfer', { receiver_id: p.receiver, amount: p.amount, memo: p.memo }, 30_000_000_000_000n, 1n)],
      });
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      if (/reject|cancel|denied|declin|closed|user/i.test(msg)) throw new WalletRejectedError(msg);
      throw err;
    }
    const o = outcome as { transaction?: { hash?: string }; transaction_outcome?: { id?: string } } | undefined;
    const hash = o?.transaction?.hash ?? o?.transaction_outcome?.id;
    if (!hash) throw new Error('The wallet did not return a transaction hash.');
    return hash;
  }

  private load(): Promise<Loaded> {
    this.loaded ??= (async () => {
      await import('./polyfills.ts');   // must run before the wallet plugins are evaluated
      const [core, ui, mnw, meteor, here, intear, tx, css] = await Promise.all([
        import('@near-wallet-selector/core'),
        import('@near-wallet-selector/modal-ui'),
        import('@near-wallet-selector/my-near-wallet'),
        import('@near-wallet-selector/meteor-wallet'),
        import('@near-wallet-selector/here-wallet'),
        import('@near-wallet-selector/intear-wallet'),
        import('@near-js/transactions'),
        import('@near-wallet-selector/modal-ui/styles.css?inline'),
      ]);
      injectModalCss(css.default);
      const selector = await core.setupWalletSelector({
        network: 'mainnet',
        modules: [mnw.setupMyNearWallet(), meteor.setupMeteorWallet(), here.setupHereWallet(), intear.setupIntearWallet()],
      });
      const modal = ui.setupModal(selector, { theme: 'dark', description: 'Connect a NEAR wallet to pay for graves in $WTH.' });
      const read = () => selector.store.getState().accounts.find((a) => a.active)?.accountId ?? null;
      this.set(read());
      selector.store.observable.subscribe(() => this.set(read()));
      return { selector, modal, actions: tx.actionCreators };
    })();
    this.loaded.catch((e) => { console.error('wallet load failed', e); this.loaded = null; });
    return this.loaded;
  }

  private set(account: string | null) {
    if (account === this.account) return;
    this.account = account;
    for (const fn of this.listeners) fn(account);
  }
}

/**
 * The picker's stylesheet @imports Google Fonts, which our Content-Security-Policy blocks (and which would
 * make the first load fail). Inject it ourselves without the external import; it falls back to system fonts.
 */
function injectModalCss(css: string) {
  if (document.getElementById('nws-modal-css')) return;
  const style = document.createElement('style');
  style.id = 'nws-modal-css';
  // matches both `@import url("…");` and the minified `@import"…";` (the URL itself contains semicolons)
  style.textContent = css.replace(/@import\s*(?:url\(\s*)?(["'])[^"']*\1\s*\)?\s*;?/g, '');
  document.head.append(style);
}
