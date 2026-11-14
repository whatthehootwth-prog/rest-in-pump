# Testing and Verification Guide

How to run the automated tests, and how to verify the live deployment without spending more than a few cents. Nothing here requires keys.

## 1. Automated tests

```bash
npm install
npm run check             # typecheck client and server, then all tests
npm test                  # tests only
```

Result on 14 Nov 2026: **12 test files, 103 tests, all passing** (vitest).

| File | Tests | Covers |
|---|---|---|
| `server/test/graves.test.ts` | 34 | Grave orders, holds, unique amounts, confirmation, duplicate hashes, expiry and recovery, offerings, EXP and levels, memorial queue, limits |
| `server/test/solana.test.ts` | 11 | Solana mint lookup, Jupiter metadata, safe logo download (private networks refused, size caps, image types) |
| `server/test/near.test.ts` | 10 | NEAR transaction verification (signer, receiver, amount, timing, failures), metadata, balances |
| `server/test/server.test.ts` | 10 | HTTP and real WebSocket sessions: two players seeing each other, resume, timeouts, capacity, bad input, foreign origins |
| `server/test/rooms.test.ts` | 9 | Room and player bookkeeping |
| `server/test/protocol.test.ts` | 7 | Wire protocol validation |
| `server/test/buyback.test.ts` | 6 | Buyback rounds with a simulated chain: threshold, 80/20 split, slippage limit, holder selection and exclusions, unknown outcomes, incomplete holder lists |
| `server/test/contract.test.ts` | 4 | The compiled Memorial NFT wasm against a mocked NEAR host: minter-only minting, one per wallet per grave, metadata |
| `server/test/search.test.ts` | 4 | Coin search ranking, RHEA list, Jupiter, already-buried coins |
| `server/test/names.test.ts` | 3 | Random names |
| `client/test/payflow.test.ts` | 3 | Browser payment flow and recovery |
| `server/test/static.test.ts` | 2 | Static file serving and path safety |

`contract.test.ts` needs the built contract (`npm run contract:build`, Rust with the `wasm32-unknown-unknown` target); without it those tests are skipped.

What the tests do not cover: real mainnet transactions (those are verified below) and a real buyback round (not yet run on mainnet).

## 2. The live game

1. Open https://rip.whatthehoot.lol and press **Enter the Meme Graveyard**.
2. Move with the arrow keys or WASD, run with Shift, hop with Space, emote with 1 to 5, chat with Enter.
3. Open a second browser window to see two owls in the same world.

The game shows a few NPC owls on each screen so it never looks empty. They exist only in your browser and are not counted as players; the top-right counter shows real players.

## 3. Inspect a memorial

In the game, walk up to a grave (the live memorials are near the gate, plots 28, 36 and 37). A card shows the memecoin, last words, creator, level, EXP and recent offerings.

Without the game:

```bash
curl https://rip.whatthehoot.lol/api/graves                                   # all memorials
curl "https://rip.whatthehoot.lol/api/graves/3?account=whatthehootest.near"     # one memorial + that wallet's NFT status
```

The second call returns, for example, `"mine":{"status":"minted","tokenId":"3-1",...}`.

## 4. Create a grave (costs real NEAR)

Graves cost `GRAVE_PRICE_USD` in NEAR (currently $0.10 on the live deployment; see `GET /api/config`).

1. Walk onto an empty plot and press **E**.
2. Type a memecoin name (for example `lonk` or `neko`) and pick it, or paste a NEAR contract or Solana mint. A memecoin that already has a memorial says so.
3. Write last words, press **Next**, connect a NEAR wallet and approve the transfer.
4. The grave appears for everyone and the creator's Memorial NFT is queued.

To see the dialog without paying, stop at the final step: it shows the exact NEAR amount and "Connect wallet & bury it".

## 5. Make an offering (from $0.10)

Walk up to any grave, press **E**, choose an offering (a candle is $0.10), connect a wallet and approve. The grave's EXP rises live and, if it is your wallet's first offering to that grave, a Memorial NFT is queued for you.

## 6. Verify the NEAR transaction

Every payment is a plain transfer to `buyback.whatthehootbrain.near`.

- Open https://nearblocks.io/address/buyback.whatthehootbrain.near and find your transfer. The amount has a unique tail of digits (that is how the server matches it to your order).
- Existing examples: https://nearblocks.io/txns/EDphamgQgat9AxcqZN5jq93X22ACmpQeZMZjMV53SxHw and https://nearblocks.io/txns/4Fi5Jd5YjEHgNs3n7EHmR7Tevp4V1tZRQu8UQy12KcCz.

## 7. Inspect a Memorial NFT

- Contract: https://nearblocks.io/address/memorial.whatthehootbrain.near
- Metadata the wallet shows: https://rip.whatthehoot.lol/nft/token/1-1.json
- Artwork: https://rip.whatthehoot.lol/nft/grave/1/media.svg
- With NEAR CLI:

```bash
near contract call-function as-read-only memorial.whatthehootbrain.near nft_tokens json-args '{"from_index":"0","limit":10}' network-config mainnet now
near contract call-function as-read-only memorial.whatthehootbrain.near memorial_of json-args '{"grave_id":1,"account_id":"whatthehootest.near"}' network-config mainnet now
```

A wallet that received a memorial sees it in its NFT collection (MyNearWallet, Meteor, HERE).

## 8. Treasury and buyback records

```bash
curl https://rip.whatthehoot.lol/api/buybacks
```

It returns the settings (threshold, team share, team wallet, buyback account, minimum holding), the amount collected so far, and every round with its payouts and transactions. The same is shown in the game under **What is Rest In Pump?** -> **How it helps $WTH**. On 14 Nov 2026 it shows the worker enabled, about $1.85 collected, and no rounds yet.

## 9. Grave progression without buying hundreds of offerings

Reaching Legendary takes 2,500 EXP (about $170 of offerings at the best rate), so judges should not try it live. Three ways to check it instead:

1. **Automated tests:** `server/test/graves.test.ts` checks the levels at 25, 250 and 2,500 EXP and renders the Memorial NFT artwork at all four levels.
2. **Local demo graves:** run the game locally and add four labelled demo graves, one per level, to the local database only:

   ```bash
   npm run build
   node scripts/demo-grave.ts           # adds 4 demo graves (plots 37, 36, 29, 28) to data/rip.sqlite
   npm start                            # open http://localhost:8787 and walk to the gate
   node scripts/demo-grave.ts --remove  # remove them afterwards
   ```

   Never run the demo script against the production database.
3. **Trailer scene:** the [demo video](https://x.com/what_the_hoot/status/2121557944718463103) or `http://localhost:8787/?film` shows one grave evolving through all four levels and the NFT art evolving with it. It is a staged scene: nothing is paid or saved.

The NFT artwork for each level is also in `client/public/docs/level-1.svg` to `level-4.svg`.

## 10. Local run without keys

Without `MINTER_PRIVATE_KEY` and `BUYBACK_PRIVATE_KEY`, the local server runs the whole game, the API and payment verification against NEAR mainnet; memorials stay queued (the UI says minting is off) and buybacks do not run. Point `TREASURY_ACCOUNT` at an account you control before testing real payments locally.
