# REST IN PUMP: Complete Scope and System Design

Everything about the project in one place: what it is, what has been built, every feature and how it works, how the money flows, what the system needs to run, and how it is designed.

Status date: 14 Nov 2026. Live at **https://rip.whatthehoot.lol** on NEAR mainnet. Last commit: `f4a5afb` (coin search in the grave dialog).

---

## Contents

1. Summary
2. Live status and accounts
3. Scope
4. What a player experiences
5. Features in detail
6. Cash flow
7. Payment workflow
8. System requirements
9. System design
10. Security
11. Testing
12. Operations
13. Known limits and open items
14. History

---

## 1. Summary

**REST IN PUMP** is a multiplayer cartoon 3D graveyard for dead memecoins.

- Every player walks around as an owl and sees everyone else in real time, with chat, silly walks and emotes.
- Anyone can **dig a grave** for a memecoin that died (on NEAR or Solana) on one of 40 plots, and carve its last words.
- Visitors leave **gifts** at graves (a candle, flowers, instant noodles, a copium tank, a rug, diamond hands). Every gift gives the grave EXP, and the grave evolves from a wooden cross into a mausoleum.
- Everyone who helps a grave earns that grave's **Memorial NFT** on NEAR. Its artwork evolves with the grave.
- Revenue funds **$WTH buyback rounds**: 20% to the team, 80% buys $WTH on RHEA and is shared with holders.

Tagline: "Every offering keeps the memory alive." A grave represents a memecoin; nobody owns it.

Brand: owl mascot, token $WTH (`wth-0b2227.launchpad.justhoot.near`), team wallet `whatthehoot.near`.

---

## 2. Live status and accounts

| Item | State |
|---|---|
| Game | Live at `https://rip.whatthehoot.lol`, hosted on Railway |
| Payments | Live on NEAR mainnet; first real grave ($NEKO, plot 37) and a candle gift made by `whatthehootest.near` |
| Memorial NFTs | Live; contract deployed, first NFTs minted (`$NEKO Memorial #001`, `$BABYBLACKDRAGON Memorial #001`) |
| Buybacks | Switched on; revenue collects in the buyback account; first round runs once $20 has collected |
| Coin search | Built and pushed; live after the next Railway deploy |
| Demo film page (`?film`) | In progress, not committed |

### NEAR accounts

| Account | Role | Keys |
|---|---|---|
| `whatthehootbrain.near` | Owner of the project accounts below; paid for their setup | Kept by the team, never on the server |
| `buyback.whatthehootbrain.near` | Treasury: receives every grave and gift payment; runs buyback rounds | Owner key + a server key (in Railway only) |
| `memorial.whatthehootbrain.near` | Memorial NFT contract (NEP-171/177/178/181) | Owner key (can upgrade the contract) |
| `minter.whatthehootbrain.near` | Mints memorials | A key that can only call `mint_memorial` (in Railway only) |
| `whatthehoot.near` | Team wallet: gets 20% of every buyback round | Team |

---

## 3. Scope

### Built

| Area | State |
|---|---|
| 3D world, owl character, 9 walk styles, 5 emotes | Done |
| Real-time multiplayer (one shared graveyard, sync, reconnect) | Done |
| Chat with speech bubbles | Done |
| Music and sound effects | Done |
| Intro page, "What is Rest In Pump?" explainer, first-time tutorial | Done |
| NPC owls with coin badges that keep the graveyard alive | Done |
| Graves for NEAR and Solana memecoins, paid in NEAR | Live |
| Coin search: type a name or ticker, dead coins included | Built, pushed |
| Gifts with fixed USD prices and EXP; 4 grave levels | Live |
| Memorial NFT contract, minter, live artwork and metadata | Live |
| Buyback rounds for $WTH holders | Live (waiting for the first $20) |
| Security hardening (audit S01 to S08) | Done |
| Demo mode (`?demo`: 40 owls for screenshots and videos) | Done |
| Setup scripts for the NFT and buyback accounts | Done |

### Not started (later)

- Memecoins on Base and Ethereum (shown in the picker as "soon").
- More plots once the 40 fill up.
- Moderation: report or hide grave messages, word filter and mute for chat.
- Terms and privacy pages.
- Horizontal scaling beyond one server process.

### Deliberately out of scope

- Player accounts. Players get a random silly name from the server.
- Removing graves. One grave per memecoin, forever.
- Staking, yield or burning on Memorial NFTs. They are normal transferable NFTs.

---

## 4. What a player experiences

1. **Intro page.** The pitch, the real online count, an **Enter the Meme Graveyard** button and the explainer (the goal, how levels work, the Memorial NFT gallery, "How it helps $WTH" with the public buyback history).
2. **First-time tutorial.** A short card page with pictures from the game.
3. **In the graveyard.** The player is an owl with a random name and one of 9 random walks. They can walk (arrows or WASD), run (Shift), hop (Space), use 5 emotes (Dance, Club, Pray, Cry, Roll; keys 1 to 5), chat (Enter), take a snapshot (P) and mute (M). Touch buttons work on phones.
4. **Empty plot.** Walking onto a plot highlights it. Pressing E opens **Dig a grave**:
   1. *Pick the coin:* choose NEAR or Solana, type the coin's name or ticker and pick it from the suggestions, or paste its address.
   2. *Last words:* up to 100 characters, shown live on the Memorial NFT preview.
   3. *Bury it:* connect a wallet and send the price in NEAR.
5. **Existing grave.** Walking up shows a card: logo, name, last words, creator, level, EXP, latest gifts. Pressing E opens **Leave a gift**.
6. **Wallets.** MyNearWallet, Meteor or HERE. The balance is checked before sending.
7. **After paying.** The grave or gift appears live for everyone and is announced in chat. Tombstones change design on level-up, and gifts pile up in front of the grave. The Memorial NFT arrives in the wallet shortly after.

---

## 5. Features in detail

### 5.1 World and characters

- A seeded graveyard, identical for every player (three.js): fence, gate, mausoleum, trees, lanterns, fog, moving grass.
- 40 plots in 5 rows of 8, either side of a central path.
- Collision with gravestones and scenery on the client; the server enforces world bounds, speed and hop height.
- Owl model built once and shared; cartoon toon shading.
- Fixed render resolution (1 pixel per CSS pixel) so it stays smooth on weak devices.

### 5.2 NPC owls

- Nameless owls that exist only on each player's own screen, so the graveyard never feels empty.
- They look like players (solid, same model) and wear a buried coin's logo on the chest.
- The visit starts with 1 to 3 of them; more slowly come and go over time, up to 15 (fewer when more real players are in).
- They wander, mourn at real graves, join your emotes, greet you with speech bubbles, tag along, hop and roll.
- `?demo` shows 40 of them, for screenshots and videos.

### 5.3 Multiplayer

- The server is the source of truth for who is online, names and accepted positions.
- Clients send their state 15 times a second, only when it changes. The server clamps every update (inside the world, max speed 3.6 m/s, max hop 2 m, valid walk and emote).
- The server broadcasts compact snapshots 15 times a second. Clients draw other players slightly in the past and interpolate.
- One shared graveyard (`MAX_ROOMS=1`, `ROOM_CAPACITY=50`).
- A dropped player keeps their slot and name for 20 seconds; a refresh resumes the same player.
- The client reconnects with backoff and shows a status banner (reconnecting, offline, full, outdated).

### 5.4 Chat

- Relayed by the server; cleaned (no control or invisible characters); max 140 characters.
- Rate-limited: a burst of 3, then one every 1.5 seconds.
- New graves, gifts and level-ups are announced in chat. No history, no moderation yet.

### 5.5 Audio

- Organ theme; dance and club tracks while you dance or club; sampled crying.
- Synthesized sounds (Web Audio) for hops, gifts, new graves, level-ups, chat and snapshots.

### 5.6 Graves

- **Finding the coin.** Players type a name or ticker; up to 6 suggestions appear with logo, ticker, name and short address (to tell clones apart). Coins that already have a grave are tagged "buried · plot #N". Pasting an address still works.
  - NEAR search uses RHEA's full token list (about 8,000 tokens, dead ones included), refreshed every 6 hours.
  - Solana search uses Jupiter's token search, which still lists pump.fun coins that stopped trading.
  - DexScreener is not used: it drops dead coins from its search.
- **Reading the coin.**
  - NEAR: the server calls `ft_metadata` on the token contract.
  - Solana: Solana RPC confirms it is an SPL or Token-2022 mint; name, ticker and logo come from Jupiter, with Token-2022 metadata as a fallback.
- **Logos.** The server downloads each logo once, checks it, and converts it to a small WebP. Browsers never load images from other sites.
- **Rules.** One USD price for every grave (`GRAVE_PRICE_USD`, default $1), paid in NEAR at the live price. One grave per memecoin, forever. The creator gets Memorial NFT #001.

### 5.7 Gifts and levels

| Gift | Price | EXP |
|---|---|---|
| Candle | $0.10 | 1 |
| Flowers | $0.20 | 2 |
| Instant noodles | $0.50 | 5 |
| Copium tank | $1 | 12 |
| A rug | $3 | 40 |
| Diamond hands | $10 | 150 |

| Level | Name | Community EXP | Tombstone |
|---|---|---|---|
| 1 | Forgotten Grave | 0 | Wooden cross |
| 2 | Remembered Grave | 25 | Rounded headstone |
| 3 | Honored Grave | 250 | Marble tomb with gold and candles |
| 4 | Legendary Grave | 2,500 | Mausoleum |

Prices and EXP live in `shared/graves.ts`; the server prices every gift itself. Each verified payment adds exactly one gift (unique key in the database).

### 5.8 Memorial NFTs

- **Who gets one:** the grave's creator (#001), and every wallet on its first gift to that grave. One per wallet per grave, enforced by both the database and the contract.
- **Title:** `$NEKO Memorial #001`, numbered per grave.
- **Live artwork:** the contract stores links under its `base_uri` (`https://rip.whatthehoot.lol/nft`). The game serves the artwork and metadata live, so every memorial of a grave evolves when the grave levels up.
- **Attributes:** memecoin name and contract, chain, grave id, level, total gifts, original wallet, personal gifts, first gift date, grave creation date.
- **Minting:** the server mints with the mint-only key. It checks `memorial_of` before every mint, so a retry never double-mints. Failures back off from 30 seconds up to 30 minutes; after 10 tries a memorial is marked `failed` and logged.
- **Contract:** `contracts/memorial` (Rust, near-sdk 5.29). The contract pays NFT storage from its own balance, about 0.01 NEAR per memorial.

### 5.9 Buyback rounds

1. Every grave and gift payment goes straight to `buyback.whatthehootbrain.near`.
2. Every 10 minutes the server checks the account. When the NEAR above a 0.5 NEAR reserve is worth $20 or more, a round runs.
3. 20% goes to `whatthehoot.near`.
4. 80% is wrapped to wNEAR and swapped for $WTH on RHEA's WTH/NEAR DCL pool, with a 2% minimum-output limit.
5. The $WTH bought is shared with holders in proportion to their holdings, in batches of 35 transfers. Left out: holders under 100,000 WTH, pools, exchanges and project wallets.

Safety: every step is recorded before it is sent. A definite failure is retried next round. An unknown outcome (for example a timeout after sending) stops everything as `needs_check` until someone looks. History is public at `/api/buybacks` and in the explainer.

### 5.10 Demo film page (in progress)

`?film` plays a scripted one-minute story inside the real game scene (lonely grave, a WTH owl cries, digs a grave, owls bring gifts, the NFT evolves, a full graveyard dances, title card). Its graves exist only on that screen. "Record video" saves an MP4 or WebM. Scenes 1 to 3 have been checked; 4 to 7 are not yet.

---

## 6. Cash flow

### 6.1 Money in

| Source | Price | Paid in | Goes to |
|---|---|---|---|
| Dig a grave | $1 (configurable) | NEAR at the live price | `buyback.whatthehootbrain.near` |
| Leave a gift | $0.10 to $10 | NEAR at the live price | `buyback.whatthehootbrain.near` |

A payment is a plain NEAR transfer from the player's wallet. No contract sits in the payment path, so there is nothing to approve beyond one transfer.

### 6.2 Money out

```
Player wallet
     |  grave or gift (plain NEAR transfer)
     v
buyback.whatthehootbrain.near ----- keeps a 0.5 NEAR reserve for gas and token storage
     |
     |  every 10 min: if (balance - reserve) >= $20, run a round
     |
     +--- 20% NEAR ----------------------------> whatthehoot.near (team)
     |
     +--- 80% NEAR -> wrap to wNEAR -> swap on RHEA (WTH/NEAR DCL, max 2% slippage)
                                           |
                                           v
                                    $WTH shared with holders
                                    (>= 100,000 WTH, pro rata, batches of 35)
```

Worked example for one $20 round: $4 of NEAR to the team, $16 of NEAR buys $WTH, and that $WTH is split among eligible holders by their share of the eligible supply.

### 6.3 Running costs

| Cost | Paid by | Size |
|---|---|---|
| Hosting (Railway service and volume) | Team | Monthly Railway bill |
| Memorial NFT storage | `memorial.whatthehootbrain.near` balance | About 0.01 NEAR per memorial; the 4 NEAR deposit (2.67 locked by the code) leaves room for about 130 memorials, then needs a top-up |
| Mint gas | `minter.whatthehootbrain.near` (0.5 NEAR); the mint key has a 0.25 NEAR gas allowance | Fractions of a cent per mint |
| Buyback gas and token storage | The 0.5 NEAR reserve in the buyback account | Small per round |
| Player transaction fees | Players | One NEAR transfer each |

### 6.4 Pricing rules

- Prices are set in USD so they stay stable; the server converts to NEAR at the live price when the order is made.
- Every order adds a random tail under 0.000001 NEAR so each transfer matches exactly one order.
- The cheapest gift ($0.10) stays above the ~0.01 NEAR storage cost of a new Memorial NFT.
- A legal check is still needed before advertising the buyback.

---

## 7. Payment workflow

```
Player              Browser (game)                Game server                      NEAR
  | press E, choose   |                              |                               |
  |------------------>| POST /api/payments           |                               |
  |                   | or /api/offerings            |                               |
  |                   |----------------------------->| USD -> NEAR at live price,    |
  |                   |                              | + unique tail; hold the plot  |
  |                   |                              | and coin for 15 min           |
  |                   |<-----------------------------| order id + exact amount       |
  | approve in wallet | wallet sends the transfer    |                               |
  |------------------>|------------------------------------------------------------->|
  |                   | tx hash saved in the browser |                               |
  |                   | POST /payments/:id/confirm   |                               |
  |                   |----------------------------->| check tx on chain: final,     |
  |                   |                              | success, signer, receiver,    |
  |                   |                              | exact amount, after the order |
  |                   |                              |------------------------------>|
  |                   |                              | create grave or gift in one   |
  |                   |                              | DB transaction; queue the NFT |
  |                   |<-----------------------------| fulfilled; broadcast to all   |
```

Rules:

- **Live price.** NEAR/USD from CoinGecko, then Coinbase, Kraken, Binance; cached one minute. If nothing answers for 15 minutes, new orders pause with a clear message. Prices outside $0.01 to $10,000 are rejected.
- **One hash, one use.** A transaction hash counts once, ever.
- **Holds.** A grave order holds its plot and coin for `HOLD_MINUTES` (15). Max 2 open holds per IP; max 3 open gifts per browser and 10 per IP.
- **Browser ownership.** Each browser has a random session id (`x-rip-session`); only that browser can confirm or cancel its order.
- **Recovery.** The tx hash is saved the moment the wallet returns it. After a refresh, a lost confirm or a wallet redirect, the game confirms that same transfer instead of asking for a second one.
- **Background sweep (every 15 s).** Expires unpaid holds and re-checks interrupted verifications. A hash NEAR never sees frees the plot 10 minutes after the hold ends, but a real late transfer still creates the grave.
- **Every state has a screen:** not connected, connecting, low balance, waiting for approval, sent, confirming, done, cancelled, failed, network error, hold expired, slow confirmation, recovery.
- **Refunds are manual.** A valid payment that arrives after its plot or coin was taken is marked `unfulfillable` and logged as `PAID BUT UNFULFILLABLE`.

---

## 8. System requirements

### 8.1 Functional requirements

| Id | Requirement |
|---|---|
| F1 | Players join a shared 3D graveyard without an account and see each other move in real time. |
| F2 | Players can chat, emote and take snapshots. |
| F3 | A player can find a dead memecoin on NEAR or Solana by name, ticker or address. |
| F4 | A player can create one grave per coin on a free plot by paying the grave price in NEAR. |
| F5 | A player can leave priced gifts at a grave; each adds fixed EXP; levels follow EXP. |
| F6 | The creator and each first-time giver receive one Memorial NFT per grave, with artwork that follows the grave's level. |
| F7 | Payments are verified on chain before anything is created; a payment never counts twice. |
| F8 | Interrupted payments (refresh, redirect, lost network) recover without a second payment. |
| F9 | Revenue funds buyback rounds with a public history. |
| F10 | All changes appear live for every player. |

### 8.2 Non-functional requirements

| Area | Requirement |
|---|---|
| Performance | Smooth on mid-range laptops and phones; state sync at 15 Hz; one fixed render resolution |
| Capacity | 50 players in one graveyard per server process |
| Availability | Graves, gifts, memorials, payments and buyback rounds survive restarts (SQLite on a persistent volume) |
| Integrity | Exact-amount matching, one-use hashes, one DB transaction per fulfilment, idempotent minting and buybacks |
| Security | No keys in the repo; mint-only key for NFTs; origin allow-list; rate limits; safe logo fetching; strict headers |
| Privacy | No accounts, no emails, no tracking; logos re-hosted so browsers never call third-party image hosts |
| Cost | Runs on one small Railway service; NFT storage paid from the contract balance |

### 8.3 Runtime requirements

| Part | Needs |
|---|---|
| Server | Node.js 22.18 or newer (Railway uses 24 via `RAILPACK_NODE_VERSION=24`); about 512 MB RAM; persistent disk for SQLite; WebSocket support; outbound HTTPS to NEAR RPC, Solana RPC, Jupiter, RHEA, FastNear and price APIs |
| Browser | A modern browser with WebGL and WebSockets (Chrome, Edge, Firefox, Safari, mobile Chrome and Safari) |
| Wallet | A NEAR mainnet wallet: MyNearWallet, Meteor or HERE |
| Contract build | Rust with the `wasm32-unknown-unknown` target (`npm run contract:build`) |
| Hosting | A host that supports long-lived WebSockets, a disk volume and background timers (static hosts such as Cloudflare Pages or Vercel do not fit) |

### 8.4 Configuration (environment variables)

| Variable | Purpose | Live value or default |
|---|---|---|
| `NODE_ENV` | Production mode | `production` |
| `PORT`, `HOST` | Listen address | Railway's `PORT` (8080); host `0.0.0.0` |
| `ALLOWED_ORIGINS` | WebSocket origin allow-list (required in production) | `https://rip.whatthehoot.lol` |
| `TRUST_PROXY` | Read client IPs from the proxy header | `1` |
| `DB_PATH` | SQLite file | `/data/rip.sqlite` |
| `PUBLIC_BASE_URL` | Public origin; NFT links are `<this>/nft` | `https://rip.whatthehoot.lol` |
| `TREASURY_ACCOUNT` | Receives payments; must equal `BUYBACK_ACCOUNT_ID` when buybacks are on | `buyback.whatthehootbrain.near` |
| `GRAVE_PRICE_USD` | Price of a grave | default `1` |
| `HOLD_MINUTES` | How long a grave order holds its plot | `15` |
| `ROOM_CAPACITY`, `MAX_ROOMS` | Players per room, rooms | `50`, `1` |
| `RECONNECT_GRACE_MS`, `SNAPSHOT_HZ`, `LOG_LEVEL` | Tuning | `20000`, `15`, `info` |
| `NEAR_RPC_URLS`, `SOLANA_RPC_URLS` | RPC endpoints in order | fastnear and near.org; Solana mainnet-beta |
| `NFT_CONTRACT`, `MINTER_ACCOUNT_ID`, `MINTER_PRIVATE_KEY` | Memorial NFT minting (secret key) | `memorial.whatthehootbrain.near`, `minter.whatthehootbrain.near` |
| `BUYBACK_ACCOUNT_ID`, `BUYBACK_PRIVATE_KEY` | Buyback account (secret key) | `buyback.whatthehootbrain.near` |
| `BUYBACK_TEAM_WALLET`, `BUYBACK_THRESHOLD_USD`, `BUYBACK_TEAM_PERCENT` | Round settings | `whatthehoot.near`, `20`, `20` |
| `BUYBACK_RESERVE_NEAR`, `BUYBACK_MIN_HOLDING_WTH`, `BUYBACK_EXCLUDE` | Reserve, holder minimum, extra excluded accounts | `0.5`, `100000`, empty |

---

## 9. System design

### 9.1 Architecture

```
                    Browser (Vite build: TypeScript + three.js)
   +-----------------------------------------------------------------+
   |  3D world, owls, NPCs, HUD, chat, dialogs, audio                |
   |  Wallet Selector (MyNearWallet / Meteor / HERE), loaded on use  |
   +-----------+----------------------+---------------------+--------+
               | WebSocket /ws        | HTTPS /api, /nft    | wallet signs
               v                      v                     v transfer
   +---------------------------------------------+    +--------------+
   |  Game server (Node, one process, Railway)   |    | NEAR mainnet |
   |                                             |    +--------------+
   |  rooms     : players, snapshots, chat       |<-->| verify txs   |
   |  api       : graves, gifts, orders, search  |    | ft_metadata  |
   |  graves    : holds, confirm, EXP, levels    |    | mint NFTs    |
   |  minter    : memorial queue -> contract     |    | buyback txs  |
   |  buyback   : rounds, swaps, payouts         |    +--------------+
   |  nft       : live metadata + SVG artwork    |
   |  search    : RHEA list, Jupiter search      |--> Solana RPC, Jupiter,
   |  price     : NEAR/USD feeds                 |    RHEA, FastNear,
   |  static    : the built client               |    price APIs
   +----------------------+----------------------+
                          |
                    SQLite (/data volume)
```

### 9.2 Server modules

| Module | Job |
|---|---|
| `index.ts`, `config.ts` | Start-up and validated configuration |
| `server.ts` | HTTP (static files, `/healthz`, `/api`, `/nft`), WebSocket, timers, security headers |
| `rooms.ts`, `names.ts` | Rooms, players, random names (pure logic) |
| `api.ts` | JSON API, rate limits, browser session header |
| `graves.ts` | Orders, holds, payment confirmation, expiry, EXP, levels, memorial queue |
| `near.ts` | NEAR RPC with fallbacks: metadata, transfer verification, balances |
| `solana.ts` | Mint lookup; safe logo download and conversion |
| `search.ts` | Coin search (RHEA list for NEAR, Jupiter for Solana), logo shrinking, caching |
| `price.ts` | Live NEAR/USD with four sources |
| `minter.ts` | Memorial minting with retries and back-off |
| `nft.ts` | Live NFT metadata JSON and SVG artwork |
| `buyback.ts` | Buyback rounds as a recorded state machine |
| `db.ts` | SQLite and migrations |

### 9.3 Background jobs (timers in the server)

| Every | Job |
|---|---|
| 1/15 s | Room snapshot broadcast |
| 15 s | Payment sweep: expire holds, re-check interrupted confirmations |
| 20 s | Minter: mint queued memorials |
| 10 min | Buyback check |
| 6 h | Refresh RHEA token list (on use) |

### 9.4 Data model (SQLite)

| Table | Holds |
|---|---|
| `payments` | Every grave and gift order: kind, status (`pending`, `confirming`, `fulfilled`, `expired`, `failed`, `unfulfillable`), exact amount, plot, coin, message, tx hash (unique), payer, browser session |
| `graves` | One row per grave: plot (unique), chain and contract (unique), name, symbol, logo, message, creator, EXP, gift count |
| `offerings` | Each gift: grave, item, EXP, payer, payment (unique) |
| `memorials` | One per wallet per grave: serial, status (`pending`, `minting`, `minted`, `failed`), tries, token id |
| `buyback_rounds` | Each round and its step states |
| `buyback_payouts` | Each holder transfer in a round |

Partial unique indexes stop two open orders for the same plot or coin.

### 9.5 HTTP and WebSocket endpoints

| Route | Purpose |
|---|---|
| `GET /healthz` | Health check |
| `GET /ws` (upgrade) | Multiplayer |
| `GET /api/config` | Prices in USD and NEAR, receiver, whether minting is on |
| `GET /api/graves`, `GET /api/graves/:id` | All graves; one grave with a wallet's memorial status |
| `GET /api/search?chain=&q=` | Up to 6 coins matching a name, ticker or address |
| `GET /api/meme?chain=&contract=` | A coin's name, ticker, logo and whether it has a grave |
| `GET /api/balance?account=` | NEAR balance |
| `POST /api/payments`, `POST /api/offerings` | New grave order (with hold), new gift order |
| `GET /api/payments/:id` | Order status |
| `POST /api/payments/:id/confirm`, `/cancel` | Confirm with a tx hash; cancel |
| `GET /api/buybacks` | Public buyback settings and history |
| `GET /nft/token/:id.json`, `/nft/grave/:id/media.svg`, `/nft/preview.svg` | Live NFT metadata, artwork, preview |

### 9.6 Multiplayer protocol

- JSON messages over one WebSocket, protocol version 3, max 1 KB per client message.
- Client to server: `hello`, `state`, `chat`, `ping` (plus `list_rooms` and `join_room`, unused while there is one room).
- Server to client: `welcome`, `snapshot`, `player_joined`, `player_left`, `presence`, `chat`, `grave_added`, `grave_updated`, `plots_reserved`, `online`, `rooms`, `error`, `pong`.
- Validation lives in `shared/protocol.ts`, shared by client and server.

### 9.7 Memorial NFT contract

- `new(owner_id, minter_id, base_uri)`; `mint_memorial` callable only by the minter; one token per wallet per grave.
- Standards: NEP-171 core, NEP-177 metadata, NEP-178 approvals, NEP-181 enumeration.
- Views: `get_owner`, `get_minter`, `memorial_of`, `memorial_count`, plus the standard NFT views. The owner can call `set_minter` and `set_base_uri`.
- Token media and reference are relative links, so artwork updates without touching the chain.

### 9.8 Buyback state machine

A round (`running`) goes through three steps: **team** (send 20% to the team wallet), **swap** (wrap NEAR with `near_deposit`, register token storage, swap on RHEA with `ft_transfer_call` and a quoted minimum) and **distribute** (one `ft_transfer` per holder, in batches of 35; each payout is `pending`, `sending` or `sent`). Each step is written to the database before it is sent. The round ends `done` or `failed` (retried next round); an unknown outcome makes it `needs_check` and stops new rounds until someone checks it.

### 9.9 Code layout

```
shared/        protocol.ts (wire protocol), graves.ts (plots, levels, gifts, chains, API shapes)
server/src/    modules listed in 9.2
client/src/    main.ts, world/, owl/, game/ (player, camera, NPCs), net/, audio/, wallet/, ui/, film/
contracts/     memorial/ (Rust NFT contract)
scripts/       deploy-memorial.ts, create-buyback.ts, demo-grave.ts (local only), docs art
server/test, client/test   automated tests
```

### 9.10 Stack

| Layer | Technology |
|---|---|
| Client | Vite 6, TypeScript, three.js 0.160, Web Audio |
| Wallet | NEAR Wallet Selector 10.1.4 |
| Server | Node 24 running TypeScript directly, `ws` for WebSockets |
| NEAR SDK | `@near-js/*` 2.5.1 (minting, buybacks, setup scripts) |
| Database | SQLite through Node's built-in `node:sqlite` |
| Images | sharp 0.35.5 |
| Contract | Rust, near-sdk 5.29, wasm32 |
| Tests | vitest |
| Hosting | Railway (service + `/data` volume), custom domain with HTTPS and WSS |

---

## 10. Security

- WebSocket origin allow-list, connection cap, 1 KB message limit, token-bucket rate limits, heartbeats; malformed messages count toward a disconnect.
- Server-side movement clamping; chat cleaning and limits.
- Security headers on every response (CSP, frame and content-type protection, `cross-origin-opener-policy: same-origin-allow-popups` for wallet popups).
- Keys only from environment variables, never in the repo; setup scripts read the owner key from hidden terminal input and never store it. The minter key can only call `mint_memorial`.
- Idempotent payments, unique amounts, one-use hashes, one DB transaction per fulfilment.
- Logo fetching cannot reach private networks: https on port 443 only, no IP literals, every resolved address and redirect checked, size caps, only known image formats, limited parallel jobs.
- Search has its own rate limit (60 per minute per visitor) and caches results for 5 minutes.
- Audit of 11 Nov 2026 (S01 to S08) fixed in `e066786`.
- Known: `npm audit` reports high entries inside the Meteor and HERE wallet SDKs; the only offered fix is a major downgrade, so none was applied.

---

## 11. Testing

- `npm run check`: typecheck client and server, then all tests.
- **103 tests in 12 files, all passing**: protocol, rooms, names, chat, graves, gifts, levels, payment flow, minting, NFT artwork and metadata, migrations, NEAR verification, Solana lookup and safe fetching, coin search, buybacks, static files, HTTP and WebSocket integration, and the compiled NFT contract against a mocked NEAR host.
- **Verified on mainnet:** a real grave payment, a real gift, Memorial NFT minting, buyback account receiving revenue.
- **Not yet seen live:** the first buyback round (needs $20 collected).

---

## 12. Operations

### Run locally

```bash
npm install
npm run build
npm start
```

Development: `npm run dev:server` and `npm run dev:client`. Local demo graves: `node scripts/demo-grave.ts` (and `--remove`). Demo views: `?demo` (40 owls), `?film` (demo film).

### Deploy

1. Push to GitHub `main`; Railway builds with `npm run build` and starts with `npm start`.
2. Volume mounted at `/data`; variables as in 8.4.

### Setup scripts (run once, by the team)

- `node scripts/deploy-memorial.ts`: creates the memorial and minter accounts, deploys and initialises the contract, gives the minter a mint-only key, prints the Railway variables. Has `--dry-run`.
- `node scripts/create-buyback.ts`: creates the buyback account with a server key and prints the Railway variables. Has `--dry-run`.

### To do before announcing

- Turn on Railway volume backups.
- Uptime monitor on `/healthz`.
- Decide who handles refunds for `unfulfillable` payments.
- Top up `memorial.whatthehootbrain.near` before it runs out of room (about 130 memorials).
- Terms and privacy pages; legal check before advertising buybacks.
- Phone testing.

---

## 13. Known limits and open items

- Player sessions are in memory; a server restart reconnects everyone as new players. Everything paid survives in SQLite.
- One server process; scaling out needs sticky sessions or a shared room service.
- Movement is client-predicted; a modified client could walk through gravestones (not out of the world).
- NFT artwork is served by the game; if the site is down, wallets cannot load images (ownership on chain is unaffected).
- Prices depend on public NEAR/USD feeds; the coin search depends on RHEA's list and Jupiter.
- Popular names have many clones in search; the short address under each suggestion is how players tell them apart.
- Names are not identities. No chat moderation yet.
- The JS bundle is about 650 KB (180 KB gzipped), mostly three.js; wallet code loads only when needed.

---

## 14. History

53 commits. Main milestones:

1. Multiplayer graveyard: rooms, synced owls, reconnect, tests.
2. Emotes, chat, snapshots, intro scene and explainer.
3. Graves, gifts, memorial levels and the Memorial NFT contract.
4. Payments as plain NEAR transfers with USD prices and unique amounts.
5. Music and sound effects.
6. Buyback rounds and launch prices.
7. NPC owls with coin logos.
8. Solana memecoins, tutorial, game-style dialogs, fixed gift prices and EXP.
9. Creator gets Memorial NFT #001.
10. Security fixes from the 11 Nov audit.
11. Demo mode, live deployment on Railway, wallet picker fix.
12. Memorial NFT and buyback accounts set up on mainnet with setup scripts.
13. Ref Finance renamed to RHEA in all text.
14. Coin search in the grave dialog.
