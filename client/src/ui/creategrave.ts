import {
  CHAINS, MESSAGE_MAX, chainName, memeAddress, nearLabel, sanitizeMessage,
  type ChainId, type GraveInfo, type MemeInfo, type PaymentView, type PriceConfig,
} from '../../../shared/graves.ts';
import { api, type CoinSuggestion } from '../net/api.ts';
import type { Wallet } from '../wallet/wallet.ts';
import { h, shortAccount } from './dom.ts';
import { PayFlow } from './payflow.ts';

/** What the address field says for each chain that can have graves. */
const CHAIN_TEXT: Record<ChainId, { label: string; placeholder: string; hint: string; bad: string }> = {
  near: { label: 'Meme token', placeholder: 'Type its name or ticker, or paste the contract', hint: "Type the coin's name or ticker and pick it, or paste the token contract. Dead coins show up too.", bad: 'That does not look like a NEAR token contract address (e.g. token.example.near).' },
  solana: { label: 'Meme token', placeholder: 'Type its name or ticker, or paste the CA', hint: "Type the coin's name or ticker and pick it, or paste the mint address (the CA). You still pay in NEAR.", bad: 'That does not look like a Solana token address. It is 32 to 44 letters and numbers.' },
  base: { label: 'Token contract', placeholder: '', hint: 'Base memes are coming soon.', bad: 'Base memes are coming soon.' },
  ethereum: { label: 'Token contract', placeholder: '', hint: 'Ethereum memes are coming soon.', bad: 'Ethereum memes are coming soon.' },
};

type Lookup =
  | { s: 'idle' } | { s: 'loading' } | { s: 'error'; msg: string; field?: boolean }
  | { s: 'exists'; meme: MemeInfo; grave: GraveInfo } | { s: 'ok'; meme: MemeInfo };

/**
 * "Dig a grave": find the coin → carve its last words → send the grave price in NEAR → a level-1 grave on the plot.
 * The left side always shows the grave's Memorial NFT; the right side has the title, steps and a footer that stays
 * at the bottom. The creator gets the grave's first Memorial NFT (#001); everyone else earns one with their first gift.
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
  private wordsError = false;
  /** Coin suggestions under the field while typing. */
  private sugg: CoinSuggestion[] = [];
  private suggOn = -1;
  private suggTimer: ReturnType<typeof setTimeout> | null = null;
  private suggSeq = 0;
  private readonly suggEl = h('ul', { id: 'grave-sugg', class: 'sugg', role: 'listbox', 'aria-label': 'Matching coins', hidden: true });
  /** Left side: the grave's Memorial NFT, always on screen (kept between renders so it doesn't flicker). */
  private readonly side = {
    img: h('img', { alt: 'Memorial NFT preview', width: 1080, height: 1380 }) as HTMLImageElement,
    name: h('p', { class: 'gs-name' }),
    words: h('blockquote', { class: 'gs-words' }),
  };
  private readonly sideEl = h('section', { class: 'grave-side lvl-1' },
    h('figure', { class: 'nft-frame' }, this.side.img, h('figcaption', {}, 'Memorial NFT · LV 1')),
    this.side.name, this.side.words);
  private readonly mainEl = h('section', { class: 'grave-main' });

  constructor(wallet: Wallet, toast: (t: string) => void) {
    this.wallet = wallet;
    this.flow = new PayFlow(wallet, {
      render: () => this.render(), isOpen: () => this.dlg.open, close: () => this.dlg.close(), toast,
      doneToast: (p) => `$${p.meme.symbol} now has a grave at plot #${p.plot}.`,
    }, 'grave');
    this.dlg.addEventListener('close', () => this.flow.stopTimer());
    this.dlg.addEventListener('click', (e) => { if (e.target === this.dlg) this.dlg.close(); });
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
    this.plot = plot; this.step = 'meme'; this.lookup = { s: 'idle' }; this.message = ''; this.contract = ''; this.wordsError = false;
    this.clearSugg();
  }

  /** Step 1's main button. Empty or malformed address: say so on the field. Found: straight on to the last words. */
  private async find() {
    this.clearSugg();
    if (!this.contract.trim()) {
      this.lookup = { s: 'error', msg: 'Paste the token address first.', field: true };
      this.render(); this.focus('#grave-contract'); return;
    }
    const contract = memeAddress(this.chain, this.contract);
    if (!contract) { this.lookup = { s: 'error', msg: CHAIN_TEXT[this.chain].bad, field: true }; this.render(); this.focus('#grave-contract'); return; }
    this.contract = contract;
    this.lookup = { s: 'loading' };
    this.render();
    try {
      const r = await api.meme(this.chain, contract);
      this.lookup = r.grave ? { s: 'exists', meme: r.meme, grave: r.grave } : { s: 'ok', meme: r.meme };
      if (this.lookup.s === 'ok') { this.step = 'words'; this.render(); this.focus('#grave-msg'); return; }
    } catch (e) {
      this.lookup = { s: 'error', msg: (e as Error).message };
    }
    this.render();
  }

  /** Step 2's main button. */
  private toPay() {
    if (!sanitizeMessage(this.message)) { this.wordsError = true; this.render(); this.focus('#grave-msg'); return; }
    this.wordsError = false; this.step = 'pay'; this.render();
  }

  private focus(sel: string) { setTimeout(() => (this.body.querySelector(sel) as HTMLElement | null)?.focus(), 0); }

  private pay() {
    const message = sanitizeMessage(this.message);
    if (!message || this.lookup.s !== 'ok') { this.step = 'words'; this.render(); return; }
    void this.flow.start(
      () => api.createGrave({ plot: this.plot, chain: this.chain, contract: this.contract, message }),
      (p) => p.kind === 'grave' && p.plot === this.plot && p.meme.contract === this.contract && p.message === message,
    );
  }

  // ------------------------------------------------------------------ coin suggestions

  /** Searches a moment after typing stops. A full address still works: it is matched like any other text. */
  private querySugg() {
    if (this.suggTimer) clearTimeout(this.suggTimer);
    const q = this.contract.trim(), chain = this.chain, seq = ++this.suggSeq;
    if (q.replace(/^\$+/, '').length < 2) { this.sugg = []; this.drawSugg(); return; }
    this.suggTimer = setTimeout(async () => {
      let results: CoinSuggestion[] = [];
      try { results = (await api.search(chain, q)).results; } catch { /* the field still takes a pasted address */ }
      if (seq !== this.suggSeq || this.step !== 'meme' || !this.dlg.open) return;
      this.sugg = results; this.suggOn = -1; this.drawSugg();
    }, 250);
  }

  private clearSugg() {
    if (this.suggTimer) clearTimeout(this.suggTimer);
    this.suggSeq++; this.sugg = []; this.suggOn = -1; this.drawSugg();
  }

  private drawSugg() {
    const el = this.suggEl;
    el.hidden = !this.sugg.length;
    const input = this.body.querySelector('#grave-contract');
    input?.setAttribute('aria-expanded', this.sugg.length ? 'true' : 'false');
    el.replaceChildren(...this.sugg.map((s, i) => h('li', {
      id: `grave-sugg-${i}`, role: 'option', 'aria-selected': i === this.suggOn ? 'true' : 'false', class: i === this.suggOn ? 'on' : '',
      onmousedown: (e: Event) => e.preventDefault(),   // keep focus in the field
      onclick: () => this.pickSugg(i),
    },
      s.icon ? h('img', { src: s.icon, alt: '', width: 28, height: 28 }) : h('span', { class: 'meme-ph' }, (s.symbol || '?').slice(0, 1).toUpperCase()),
      h('span', { class: 'sugg-txt' },
        h('span', { class: 'sugg-top' }, h('b', {}, `$${s.symbol}`), h('span', { class: 'sugg-name' }, s.name)),
        h('span', { class: 'mono small muted' }, shortAddr(s.contract))),
      s.plot !== null ? h('span', { class: 'sugg-tag' }, `buried · plot #${s.plot}`) : null)));
    if (this.suggOn >= 0) input?.setAttribute('aria-activedescendant', `grave-sugg-${this.suggOn}`);
    else input?.removeAttribute('aria-activedescendant');
  }

  private pickSugg(i: number) {
    const s = this.sugg[i];
    if (!s) return;
    this.contract = s.contract;
    const input = this.body.querySelector('#grave-contract') as HTMLInputElement | null;
    if (input) input.value = s.contract;
    void this.find();
  }

  private suggKey(e: KeyboardEvent) {
    const n = this.sugg.length;
    if (e.key === 'ArrowDown' && n) { e.preventDefault(); this.suggOn = (this.suggOn + 1) % n; this.drawSugg(); return; }
    if (e.key === 'ArrowUp' && n) { e.preventDefault(); this.suggOn = (this.suggOn - 1 + n) % n; this.drawSugg(); return; }
    if (e.key === 'Escape' && n) { e.preventDefault(); e.stopPropagation(); this.clearSugg(); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      // Enter picks the highlighted coin, or the top match when the text is not an address
      if (this.suggOn >= 0) this.pickSugg(this.suggOn);
      else if (!memeAddress(this.chain, this.contract) && n) this.pickSugg(0);
      else void this.find();
    }
  }

  // ------------------------------------------------------------------ rendering

  private render() {
    const order = ['meme', 'words', 'pay'] as const;
    const head = h('div', { class: 'gm-head' },
      h('h2', { id: 'grave-title' }, 'Dig a grave', h('span', { class: 'gm-plot' }, `plot #${this.plot}`)),
      h('button', { class: 'gift-x', type: 'button', 'aria-label': 'Close', onclick: () => this.dlg.close() }, '×'));
    const steps = h('ol', { class: 'steps', 'aria-label': 'Steps' },
      ...(['Pick the coin', 'Last words', 'Bury it'] as const).map((label, i) =>
        h('li', { class: order.indexOf(this.step) === i ? 'on' : order.indexOf(this.step) > i ? 'done' : '' }, h('span', { class: 'n', 'aria-hidden': 'true' }, String(i + 1)), h('span', { class: 't' }, label))));
    const [view, foot] = this.step === 'meme' ? this.renderMeme() : this.step === 'words' ? this.renderWords() : this.renderPay();
    this.mainEl.replaceChildren(head, steps, h('div', { class: 'gm-body' }, view), h('div', { class: 'gm-foot' }, ...foot));
    if (this.body.firstChild?.nodeName !== 'DIV') this.body.replaceChildren(h('div', { class: 'grave-layout' }, this.sideEl, this.mainEl));
    this.updateSide();
  }

  /** The NFT: a blank "???" coin until one is found, then that coin's logo; the real grave's art once it is buried. */
  private updateSide() {
    const F = this.flow.state, L = this.lookup;
    const meme = L.s === 'ok' ? L.meme : null;
    const src = F.s === 'done' && F.payment.grave ? `/nft/grave/${F.payment.grave.id}/media.svg`
      : meme ? `/nft/preview.svg?chain=${encodeURIComponent(meme.chain)}&contract=${encodeURIComponent(meme.contract)}`
      : '/nft/preview.svg';
    if (this.side.img.getAttribute('src') !== src) this.side.img.src = src;
    this.side.name.textContent = meme ? `${meme.name} · $${meme.symbol}` : 'Your dead coin goes here';
    this.updateWords();
  }

  private updateWords() {
    const text = this.message.trim();
    this.side.words.textContent = text || 'Its last words go here…';
    this.side.words.classList.toggle('empty', !text);
  }

  private closeBtn() { return h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => this.dlg.close() }, 'Close'); }

  private renderMeme(): [Node, Node[]] {
    const L = this.lookup;
    const bad = L.s === 'error' && L.field;
    const input = h('input', {
      id: 'grave-contract', value: this.contract, placeholder: CHAIN_TEXT[this.chain].placeholder, spellcheck: 'false', autocomplete: 'off',
      'aria-label': CHAIN_TEXT[this.chain].label, 'aria-invalid': bad ? 'true' : 'false', class: bad ? 'invalid' : '',
      oninput: (e: Event) => {
        this.contract = (e.target as HTMLInputElement).value;
        this.querySugg();
        if (this.lookup.s === 'error') { this.lookup = { s: 'idle' }; (e.target as HTMLElement).classList.remove('invalid'); const m = this.body.querySelector('#grave-find-msg'); if (m) { m.className = 'field-msg'; m.textContent = CHAIN_TEXT[this.chain].hint; } }
      },
      onkeydown: (e: Event) => this.suggKey(e as KeyboardEvent),
      onblur: () => setTimeout(() => this.clearSugg(), 150),
      role: 'combobox', 'aria-autocomplete': 'list', 'aria-controls': 'grave-sugg', 'aria-expanded': 'false',
    });
    const chainSel = h('select', { 'aria-label': 'Chain', onchange: (e: Event) => { this.chain = (e.target as HTMLSelectElement).value as ChainId; this.lookup = { s: 'idle' }; this.clearSugg(); this.render(); this.querySugg(); } },
      ...CHAINS.map((c) => h('option', { value: c.id, disabled: !c.live, selected: c.id === this.chain }, c.live ? c.name : `${c.name} (soon)`)));
    const msg =
      L.s === 'loading' ? h('p', { id: 'grave-find-msg', class: 'field-msg busy-line' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), `Looking it up on ${chainName(this.chain)}…`)
      : L.s === 'error' ? h('p', { id: 'grave-find-msg', class: 'field-msg bad', role: 'alert' }, L.msg)
      : L.s === 'exists' ? h('p', { id: 'grave-find-msg', class: 'field-msg bad', role: 'alert' }, `$${L.meme.symbol} already has a grave at plot #${L.grave.plot}. Each coin gets one grave, so go leave a gift there.`)
      : h('p', { id: 'grave-find-msg', class: 'field-msg' }, CHAIN_TEXT[this.chain].hint);
    const view = h('div', { class: 'dlg-step' },
      h('label', { class: 'lbl', for: 'grave-contract' }, CHAIN_TEXT[this.chain].label),
      h('div', { class: 'row' }, chainSel, h('div', { class: 'sugg-wrap' }, input, this.suggEl)),
      msg);
    const find = h('button', { class: 'btn btn-go', type: 'button', disabled: L.s === 'loading', onclick: () => void this.find() }, L.s === 'loading' ? 'Finding…' : 'Find meme token');
    return [view, [this.closeBtn(), find]];
  }

  private renderWords(): [Node, Node[]] {
    const meme = this.lookup.s === 'ok' ? this.lookup.meme : null;
    const len = [...this.message].length;
    const ta = h('textarea', {
      id: 'grave-msg', maxlength: MESSAGE_MAX, rows: 3, placeholder: 'Here lies my portfolio. It went to zero, as foretold.',
      'aria-describedby': 'grave-count', 'aria-invalid': this.wordsError ? 'true' : 'false', class: this.wordsError ? 'invalid' : '',
      oninput: (e: Event) => {
        this.message = (e.target as HTMLTextAreaElement).value;
        const c = document.getElementById('grave-count'); if (c) c.textContent = `${[...this.message].length}/${MESSAGE_MAX}`;
        if (this.wordsError && sanitizeMessage(this.message)) { this.wordsError = false; (e.target as HTMLElement).classList.remove('invalid'); this.body.querySelector('#grave-words-msg')?.remove(); }
        this.updateWords();
      },
      onkeydown: (e: Event) => { const k = e as KeyboardEvent; if (k.key === 'Enter' && !k.shiftKey) { e.preventDefault(); this.toPay(); } },
    });
    ta.value = this.message;
    const view = h('div', { class: 'dlg-step' },
      meme ? tokenRow(meme, () => { this.step = 'meme'; this.render(); }) : null,
      h('label', { class: 'lbl', for: 'grave-msg' }, 'Its last words'),
      ta,
      h('div', { class: 'words-meta' },
        this.wordsError ? h('p', { id: 'grave-words-msg', class: 'field-msg bad', role: 'alert' }, 'Write its last words first (1 to 100 characters).') : h('p', { class: 'field-msg' }, 'Shown on the grave and its Memorial NFT.'),
        h('span', { id: 'grave-count', class: 'count' }, `${len}/${MESSAGE_MAX}`)));
    return [view, [
      h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => { this.step = 'meme'; this.render(); } }, 'Back'),
      h('button', { class: 'btn btn-go', type: 'button', onclick: () => this.toPay() }, 'Next')]];
  }

  private renderPay(): [Node, Node[]] {
    const cfg = this.config, meme = this.lookup.s === 'ok' ? this.lookup.meme : null;
    const F = this.flow.state;
    if (F.s === 'done') {
      const g = F.payment.grave;
      return [h('div', { class: 'dlg-step done' },
        h('div', { class: 'celebrate' }, h('p', { class: 'cele-title' }, 'Buried!'),
          h('p', { class: 'cele-sub' }, g ? `$${g.meme.symbol} now rests at plot #${g.plot}.` : 'Your grave is ready.')),
        h('ol', { class: 'next-list' },
          h('li', {}, h('b', {}, 'Everyone can see it now.'), ' Owls walking past can visit your grave.'),
          h('li', {}, h('b', {}, 'Gifts give it EXP.'), ' It levels up and grows as people leave them.'),
          h('li', {}, h('b', {}, 'Memorial NFT #001 is yours.'), ' It is on its way to your wallet and evolves with the grave.'))),
      [h('button', { class: 'btn btn-go', type: 'button', onclick: () => this.dlg.close() }, 'R.I.P.')]];
    }
    if (!cfg) {
      return [h('div', { class: 'dlg-step' }, this.configError
        ? h('p', { class: 'status bad' }, `Could not load prices: ${this.configError}`)
        : h('p', { class: 'status busy' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Loading prices…')), [this.closeBtn()]];
    }
    const amount = this.flow.payment?.amount ?? cfg.gravePrice;
    if (!amount || !cfg.nearUsd) {
      return [h('div', { class: 'dlg-step' }, h('p', { class: 'status bad' }, 'Could not get the NEAR price right now, so graves are paused for a moment. Try again in a minute.')), [this.closeBtn()]];
    }
    const price = nearLabel(amount);
    const acct = this.wallet.account;
    // the coin and its words, then what it costs and what you get
    const view = h('div', { class: 'dlg-step' },
      meme ? tokenRow(meme) : null,
      h('div', { class: 'deal' },
        h('div', { class: 'deal-cost' },
          h('span', { class: 'deal-label' }, 'Cost'),
          h('div', { class: 'deal-amount' }, h('span', { class: 'near-coin', 'aria-hidden': 'true' }, 'N'), h('b', {}, price.replace(' NEAR', '')), h('small', {}, 'NEAR'))),
        h('div', { class: 'deal-arrow', 'aria-hidden': 'true' }, '▶'),
        h('div', { class: 'deal-get' },
          h('span', { class: 'deal-label' }, 'You get'),
          h('b', {}, 'Memorial NFT #001'),
          h('small', {}, 'and the grave'))),
      acct ? h('p', { class: 'deal-wallet' }, `Wallet: ${shortAccount(acct)}`) : null);
    const flow = this.flow.view({
      price, decimals: cfg.decimals, actionLabel: `Bury it · ${price}`, connectLabel: 'Connect wallet & bury it',
      onAction: () => this.pay(), onClose: () => this.dlg.close(),
      back: () => { this.step = 'words'; this.render(); },
    });
    return [view, [h('div', { class: 'gm-flow' }, flow)]];
  }
}

/** "abc…xyz" for long addresses; short NEAR names stay whole. */
function shortAddr(a: string): string { return a.length > 30 ? `${a.slice(0, 12)}…${a.slice(-8)}` : a; }

/** The found coin: logo, name, ticker, chain (and a Change link on step 2). */
function tokenRow(m: MemeInfo, change?: () => void): Node {
  return h('div', { class: 'token-row' },
    m.icon ? h('img', { src: m.icon, alt: '' }) : h('span', { class: 'meme-ph' }, (m.symbol || '?').slice(0, 1).toUpperCase()),
    h('div', { class: 'token-txt' },
      h('b', {}, m.name), h('span', { class: 'tick' }, `$${m.symbol}`),
      h('p', { class: 'mono small muted' }, `${chainName(m.chain)} · ${m.contract}`)),
    change ? h('button', { class: 'link-btn', type: 'button', onclick: change }, 'Change') : null);
}
