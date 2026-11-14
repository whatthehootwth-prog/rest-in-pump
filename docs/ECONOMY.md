# Economy

How money moves in REST IN PUMP: what players pay, how payments are verified, how memorials progress, and how revenue becomes WTH buybacks for eligible holders. Values come from the code (`shared/graves.ts`, `server/src/config.ts`, `server/src/graves.ts`, `server/src/price.ts`, `server/src/buyback.ts`) and from the live deployment's public endpoints on 14 Nov 2026.

The short version: players pay small amounts of NEAR for graves and offerings; the server verifies each payment on chain; the NEAR collects in a treasury account; when $20 is available, the server sends 20% to the team and swaps 80% for WTH, which it distributes to eligible holders in proportion to their holdings. Buyback funding comes from paid game activity, not from WTH trading fees.

---

## 1. Prices

Prices are set in USD and paid in NEAR at the live NEAR price, so they stay stable when NEAR moves.

### Graves

| Setting | Code default | Live value (14 Nov 2026) |
|---|---|---|
| `GRAVE_PRICE_USD` | $1 | $0.10 (test setting; check `GET /api/config` for the current value) |

One memorial per memecoin (chain + contract), forever. Graves cannot be removed.

### Offerings

Fixed in `OFFERING_ITEMS` (`shared/graves.ts`). The server prices every offering itself; the browser cannot choose an amount.

| Offering | Price | Community EXP | EXP per $ |
|---|---|---|---|
| Candle | $0.10 | 1 | 10 |
| Flowers | $0.20 | 2 | 10 |
| Instant noodles | $0.50 | 5 | 10 |
| Copium tank | $1 | 12 | 12 |
| A rug | $3 | 40 | 13.3 |
| Diamond hands | $10 | 150 | 15 |

Bigger offerings give slightly more EXP per dollar. The cheapest offering ($0.10) is kept above the roughly 0.01 NEAR storage cost of a new Memorial NFT.

## 2. Memorial progression

A grave's level comes only from its community EXP, the sum of the EXP of every verified offering made there.

| Level | Name | Community EXP | In the world |
|---|---|---|---|
| 1 | Forgotten Grave | 0 | Wooden cross |
| 2 | Remembered Grave | 25 | Rounded headstone |
| 3 | Honored Grave | 250 | Marble tomb with gold and candles |
| 4 | Legendary Grave | 2,500 | Mausoleum |

Grave creation itself gives no EXP. EXP, levels and offering counts are stored by the game server (SQLite), not on chain. Each verified payment adds exactly one offering (a unique key links one payment to at most one offering).

## 3. Paying

### Currency and recipient

- Currency: NEAR (24 decimals).
- Recipient: the `TREASURY_ACCOUNT`, currently `buyback.whatthehootbrain.near`. When buybacks are on, the server refuses to start unless the treasury and the buyback account are the same account.
- Mechanism: one plain NEAR transfer signed by the player's wallet. There is no payment contract.

### USD to NEAR

- NEAR/USD comes from CoinGecko, then Coinbase, Kraken, Binance (first that answers), cached for one minute.
- Prices outside $0.01 to $10,000 per NEAR are rejected as implausible.
- If no source has answered for 15 minutes, new orders pause with a clear message rather than charging a guessed amount.

### Unique amounts

A plain NEAR transfer cannot carry a memo, so the amount itself identifies the order:

1. The USD price is converted to NEAR and rounded up to a whole 0.000001 NEAR.
2. A random tail below 0.000001 NEAR is added, chosen so that no other recent order has the same amount.

The player's wallet shows this exact amount. Because amounts differ, one transfer can never be claimed by another order.

### Verification

When the browser confirms an order with a transaction hash, the server asks NEAR for the transaction (`EXPERIMENTAL_tx_status`, waiting for finality) and accepts it only if:

- it is final and successful, and the transfer receipt on the treasury succeeded;
- it was signed by the account the player connected;
- it was sent to the treasury;
- it contains a transfer of exactly the order's amount;
- its block is newer than the order (with two minutes of clock skew allowed);
- its hash has never been used before.

Then the grave or offering is created and the Memorial NFT (if any) is queued, in one database transaction.

### Holds and expiry

- A grave order holds its plot and memecoin for `HOLD_MINUTES` (default 15; the live deployment is currently set to 1). Limits: 2 open grave holds per IP, 3 open offerings per browser and 10 per IP.
- A background job runs every 15 seconds: it expires unpaid holds and re-checks verifications that were interrupted.
- A hash NEAR has never seen frees the plot 10 minutes after the hold ends, but stays under check, so a real late transfer still creates the grave.
- The browser stores the transaction hash as soon as the wallet returns it. After a refresh, a lost confirmation or a wallet redirect, it confirms that same transfer instead of asking for a second payment.

### Refunds

Refunds are manual. If a valid grave payment arrives after its hold expired and someone else took the plot or the memecoin in the meantime, the payment is marked `unfulfillable` and logged as `PAID BUT UNFULFILLABLE` for the operator to refund.

## 4. Memorial NFTs and the economy

- The grave's creator receives Memorial NFT #001 when the grave is created.
- Any other wallet receives one with its first verified offering to that grave. More offerings from the same wallet do not mint more NFTs.
- Minting is paid by the project: the contract pays storage from its own balance (about 0.01 NEAR per memorial) and the minter account pays gas.
- NFTs are normal transferable NEP-171 tokens. They carry no staking, yield or revenue rights; holding a Memorial NFT does not make a wallet eligible for WTH distributions.

## 5. Buyback rounds

### Treasury balance and reserve

The buyback worker computes the available amount as:

```
available = spendable balance of the treasury - BUYBACK_RESERVE_NEAR (0.5 NEAR)
```

The spendable balance already excludes NEAR locked for the account's storage. The 0.5 NEAR reserve covers gas and token storage registration and is never spent by a round.

### Schedule and threshold

- The server checks the treasury every 10 minutes.
- A round starts when `available` is worth at least `BUYBACK_THRESHOLD_USD` ($20) at the current NEAR price.
- A new round never starts while one is running or while any round is waiting for a manual check.

### Allocation

| Share | Setting | Goes to |
|---|---|---|
| 20% | `BUYBACK_TEAM_PERCENT` | `BUYBACK_TEAM_WALLET` (`whatthehoot.near`) as NEAR |
| 80% | the rest | Swapped for WTH and distributed to eligible holders |

### The swap

1. The treasury registers itself for storage on `wrap.near` and on the WTH token if needed.
2. The server asks RHEA's DCL contract (`dclv2.ref-labs.near`) for a quote on the WTH/NEAR pool `wrap.near|wth-0b2227.launchpad.justhoot.near|10000`.
3. In one transaction, it wraps the NEAR (`near_deposit`) and sends the wNEAR to the DCL contract with `ft_transfer_call` and a `Swap` message whose `min_output_amount` is 98% of the quote. If the pool cannot deliver that much, the DEX contract rejects the swap.
4. The WTH received is measured as the change in the treasury's WTH balance.

### Eligible holders

- Source: FastNear's top-holders list for the WTH token (`api.fastnear.com/v1/ft/<WTH>/top`).
- Minimum holding: `BUYBACK_MIN_HOLDING_WTH` = 100,000 WTH.
- Always excluded: the RHEA DCL and v2 contracts, `intents.near`, the WTH token contract, the justhoot launchpad, router and reward contracts, the treasury itself, the team wallet, and anything listed in `BUYBACK_EXCLUDE`.
- If the list may have been cut off while its last entry is still above the minimum holding, the round stops instead of paying an incomplete list.

### Distribution

- Each eligible holder receives `WTH bought x their holding / total eligible holdings` (integer division; dust stays in the treasury).
- Payouts are sent as WTH `ft_transfer` calls in batches of 35 per transaction, memo `Rest In Pump buyback`.

### Worked example: a $20 round

Assume NEAR = $3.32 and the treasury holds 6.524 NEAR, so 6.024 NEAR ($20.00) is available above the 0.5 NEAR reserve.

| Step | Amount |
|---|---|
| Available for the round | 6.024 NEAR ($20.00) |
| Team share (20%) to `whatthehoot.near` | 1.2048 NEAR ($4.00) |
| Swapped for WTH (80%) | 4.8192 NEAR ($16.00) |
| Minimum accepted output | 98% of RHEA's quote |
| Left in the treasury | 0.5 NEAR reserve |

Suppose the swap returns 1,000,000 WTH and three holders are eligible with 500,000, 300,000 and 200,000 WTH (1,000,000 eligible in total). They receive 500,000, 300,000 and 200,000 WTH from the buyback. The WTH amount depends entirely on the pool at that moment; the figure here is only for the arithmetic.

### Failures, retries and manual intervention

Each round is a recorded sequence of steps: `team` -> `swap` -> `distribute`. Before a transaction is sent, its step is marked as "sending" in the database.

| Situation | What happens |
|---|---|
| A step fails definitely before anything was sent (for example a rejected transaction) | The marker is undone and the step is retried at the next check |
| RHEA returns no quote | The round is marked `failed` |
| The outcome of a sent transaction is unknown (timeout, lost connection) | The round becomes `needs_check`; no further rounds start until an operator checks the chain and clears it |
| The server restarts in the middle of sending | Same as unknown: `needs_check` |
| The swap finished but no WTH arrived | `needs_check` |
| The holder list may be incomplete, or nobody is eligible | `needs_check` |

Every round and every payout (account, holding, amount, status, transaction) is public at `GET /api/buybacks` and in the game's "How it helps $WTH" panel.

### Status on mainnet

As of 14 Nov 2026 the worker is enabled, but no round has run: about $1.85 was available against the $20 threshold. The buyback logic is covered by automated tests with a simulated chain (`server/test/buyback.test.ts`); the first real round has not yet happened.

## 6. Team and admin controls

| Control | Who | Effect |
|---|---|---|
| Prices, hold time, threshold, team share, reserve, minimum holding, exclusions | The server operator (environment variables) | Applied on restart |
| Treasury keys | The owner key and the server's key are both full-access keys on `buyback.whatthehootbrain.near` | Can move any funds in the treasury |
| NFT contract settings | `whatthehootbrain.near` (contract owner) | `set_minter`, `set_base_uri` |
| NFT contract code | Full-access key of `memorial.whatthehootbrain.near` (held by the owner) | Can redeploy the contract |
| Minting | `minter.whatthehootbrain.near` | Its server key can only call `mint_memorial` |

Players must trust the operator to run the server as published. See [SECURITY.md](SECURITY.md).

## 7. Operational costs

| Cost | Paid from | Notes |
|---|---|---|
| Hosting | Team | Railway service plus a persistent volume |
| NFT storage | `memorial.whatthehootbrain.near` balance | About 0.01 NEAR per memorial; the 4 NEAR deposit (about 2.67 NEAR locked by the contract code) leaves room for roughly 130 memorials before a top-up |
| Mint gas | `minter.whatthehootbrain.near` | The mint-only key has a 0.25 NEAR gas allowance |
| Buyback gas and storage | The treasury's 0.5 NEAR reserve | Small per round |
| Player fees | Players | One NEAR transfer per grave or offering |

## 8. Limitations

- **Revenue depends on activity.** Buybacks happen only when players spend at least $20 between rounds. Quiet periods mean no rounds.
- **No guarantees.** Nothing here promises payouts, investment returns or any effect on the WTH price.
- **Off-chain rules.** The allocation, schedule and holder selection are enforced by the game server, not by a contract.
- **Data sources.** Pricing depends on public NEAR/USD feeds; holder selection depends on FastNear's holder list (rounds stop if it may be incomplete).
- **Legal.** Sharing revenue with token holders can have legal consequences in some jurisdictions; the project should get advice before promoting it.
