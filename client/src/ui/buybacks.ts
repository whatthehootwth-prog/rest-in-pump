import { formatUnits, nearLabel } from '../../../shared/graves.ts';
import { h } from './dom.ts';

/** The live buyback section in "What is Rest In Pump?": progress to the next round, and every past round. */
interface Round {
  id: number; status: string; at: number; nearTotal: string; nearTeam: string; nearBuy: string; usd: number;
  teamTx: string | null; swapTx: string | null; wthBought: string | null;
  payouts: { account: string; amount: string; status: string; tx: string | null }[];
}
interface Info {
  enabled: boolean; thresholdUsd: number | null; teamPercent: number | null; teamWallet: string | null; account: string | null;
  collected: { near: string; usd: number | null } | null; rounds: Round[];
}

const tx = (hash: string | null, label: string) => (hash ? h('a', { href: `https://nearblocks.io/txns/${hash}`, target: '_blank', rel: 'noopener noreferrer' }, label) : null);
const wth = (units: string) => `${formatUnits(units, 18, 0)} WTH`;

export async function renderBuybacks(el: HTMLElement): Promise<void> {
  el.replaceChildren(h('p', { class: 'muted small' }, 'Loading buyback rounds…'));
  let info: Info;
  try {
    const r = await fetch('/api/buybacks', { cache: 'no-store' });
    if (!r.ok) throw new Error(String(r.status));
    info = (await r.json()) as Info;
  } catch {
    el.replaceChildren(h('p', { class: 'muted small' }, 'Could not load the buyback rounds right now.'));
    return;
  }
  if (!info.enabled) {
    el.replaceChildren(h('p', { class: 'muted small' }, 'Automatic buybacks are not switched on yet. Rounds will be listed here, with every transaction, once they are.'));
    return;
  }
  const parts: Node[] = [];
  const c = info.collected;
  parts.push(h('p', { class: 'small' }, c?.usd != null
    ? `Collected for the next round: about $${c.usd.toFixed(2)} of $${info.thresholdUsd} (${nearLabel(c.near)}).`
    : 'Collected for the next round: checking…'));
  if (!info.rounds.length) parts.push(h('p', { class: 'muted small' }, 'No rounds yet.'));
  for (const r of info.rounds) {
    const paid = r.payouts.filter((p) => p.status === 'sent').length;
    const status = r.status === 'done' ? 'done' : r.status === 'running' ? 'in progress' : r.status === 'needs_check' ? 'paused for a check' : 'failed';
    parts.push(h('div', { class: 'bb-round' },
      h('div', { class: 'bb-head' }, h('b', {}, `Round ${r.id}`), ` · ${new Date(r.at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })} · ${status}`),
      h('p', { class: 'small' },
        `About $${r.usd.toFixed(2)} (${nearLabel(r.nearTotal)}): ${nearLabel(r.nearTeam)} to the WTH wallet `, tx(r.teamTx, '(tx)'),
        `, ${nearLabel(r.nearBuy)} bought ${r.wthBought ? wth(r.wthBought) : 'WTH'} `, tx(r.swapTx, '(tx)'),
        r.payouts.length ? `, shared with ${paid} of ${r.payouts.length} holders.` : '.'),
      r.payouts.length ? h('details', {}, h('summary', {}, 'Who received what'),
        h('ul', { class: 'bb-list' }, ...r.payouts.map((p) => h('li', {}, h('span', { class: 'mono' }, p.account), ` · ${wth(p.amount)} `, tx(p.tx, '(tx)'))))) : null,
    ));
  }
  el.replaceChildren(...parts);
}
