# REST IN PUMP: Project Overview

A full write-up of what has been built so far: the idea, scope, every feature, how each flow works end to end, the technical design, the money strategy, security, testing, and what is left before and after launch.

Status date: 11 Nov 2026. Last commit: `e066786` (security fixes from the 11 Nov audit).

---

## 1. The idea

**REST IN PUMP** is a multiplayer cartoon 3D graveyard for dead memecoins.

- Every player walks around as the owl mascot and sees everyone else in real time.
- Anyone can dig a grave for a memecoin that died (on NEAR or Solana) on one of the empty plots, with last words on the tombstone.
- Other players leave funny gifts at graves (a candle, instant noodles, a copium tank, a rug, diamond hands). Every gift gives the grave EXP, and the grave evolves from a wooden cross into a mausoleum as its community EXP grows.
- Everyone who helps a grave earns that grave's **Memorial NFT**, whose artwork evolves with the grave.
- All revenue can be routed into **buyback rounds** that buy $WTH and share it with holders.

Tagline: "Every offering keeps the memory alive." A grave represents a memecoin; nobody owns it.

Brand: owl mascot, project wallet `whatthehoot.near`, token $WTH, planned domain `whatthehoot.lol`.

---

## 2. Scope

### In scope and built

| Area | State |
|---|---|
| 3D world, owl character, animations, emotes | Done |
| Real-time multiplayer (one shared graveyard, sync, reconnect) | Done |
| Chat with speech bubbles | Done |
| Music and sound effects | Done |
| Intro page, explainer docs, first-time tutorial | Done |
| Ghost NPC owls that keep the graveyard alive | Done |
| Graves for NEAR and Solana memecoins, paid in NEAR | Built and tested; no real mainnet payment made yet |
| Gifts with fixed prices and EXP, grave levels | Built and tested |
| Memorial NFT contract, minter, live metadata and artwork | Built and tested; contract not deployed |
| Buyback rounds for $WTH holders | Built and tested; switched off |
| Security hardening (audit S01 to S08) | Fixed and committed |

### Not started (later)

- Grave search (by name, ticker or contract).
- Memecoins on Base and Ethereum (shown in the picker as not live yet).
- More plots once the 40 fill up.
- Moderation: report or hide grave messages, profanity filter and mute for chat.
- Horizontal scaling beyond one server process.

### Deliberately out of scope

- Player accounts. Players get a random silly name from the server and cannot change it.
- Removing graves. One grave per memecoin contract, forever.
- Staking, yield or token burning on Memorial NFTs. They are normal transferable NFTs.

---

## 3. What a player experiences (user flow)

1. **Intro page.** Pitch, the real online player count, an "Enter the Meme Graveyard" button and a "What is Rest In Pump?" explainer with side tabs (the goal, how levels work, the Memorial NFT tier gallery, "How it helps $WTH" with the public buyback history). Joining happens only when the player presses Enter.
2. **First-time tutorial.** A "Welcome to Rest In Pump" card page with pictures taken from the game.
3. **In the graveyard.** The player is an owl with a random name and one of 9 random weird walks (both assigned by the server). They can:
   - walk, run and hop,
   - use 5 emotes from the emote bar or keys 1 to 5: Dance, Club, Pray, Cry (kneels and cries), Roll,
   - chat (Enter always opens the chat box; messages show as speech bubbles),
   - take a snapshot PNG (P),
   - mute music and sounds (M).
4. **Empty plot.** Walking onto one of the 40 plots highlights the whole plot, and a sign says "DEAD MEME HERE". Pressing E opens **"Dig a grave"**.
5. **Existing grave.** Walking up shows a plot card: the coin's logo, name, last words, creator wallet, level, EXP and the latest gifts. Pressing E opens **"Leave a gift"**.
6. **Wallet.** Connect with MyNearWallet, Meteor or HERE. The balance is checked before sending.
7. **After paying.** The grave or gift appears live for everyone, it is announced in chat, the tombstone changes design on level-up, and gifts pile up in front of the grave (spilling onto the grass at busy graves).

---

## 4. Functionality in detail

### 4.1 World and characters

- A seeded graveyard, identical for every player (three.js).
- 40 plots in 5 rows of 8, with a path through the middle near the gate.
- Collision with gravestones and scenery on the client; the server enforces world bounds and speed.
- Owl model built once and shared; cartoon toon shading.
- 9 walk styles, 5 emotes, all synced to everyone.
- Fixed low render resolution for a consistent look and speed on weak devices.

### 4.2 Ghost NPC owls

- Nameless, see-through ghost owls that exist only on each player's own screen.
- Between 3 and 15 of them: 15 when you are alone, about 1.5 fewer for each extra real player, never under 3.
- They come and go: every 10 to 30 seconds one fades in somewhere, or rises up and vanishes.
- Each wears a dead coin's logo on its chest (from the real graves), at 50% to 80% opacity.
- They wander, cry only at real graves (in a row beside you, facing where you face), join your emotes with their own timing, greet you with speech bubbles, tag along, club with you, hop and roll.

### 4.3 Multiplayer

- The server is the source of truth for who is online, names and accepted positions.
- Clients send their state at 15 Hz (only on change). The server clamps every update: inside the world, no faster than run speed, sane hop height, valid walk style and emote.
- The server broadcasts compact room snapshots at 15 Hz. Clients draw other players 120 ms in the past and interpolate.
- One shared graveyard (`MAX_ROOMS=1`, `ROOM_CAPACITY=50`). The server could split into instances, but there is no room picker.
- A dropped player keeps their slot, id and name for 20 seconds. The session token lives in sessionStorage, so a refresh resumes the same player.
- The client reconnects with backoff and shows a clear status banner (reconnecting, offline, full, outdated).

### 4.4 Chat

- Relayed by the server to the room. Cleaned (no control or zero-width characters), max 140 characters.
- Rate-limited: burst of 3, then one every 1.5 seconds.
- Gifts and level-ups are announced in chat.
- No history and no moderation yet.

### 4.5 Audio

- Organ theme, bouncy dance track and club track while you dance or club, sampled crying (harder when rolling).
- Synthesized sounds (Web Audio) for hop, gifts, new graves, level-ups, chat and snapshots.

### 4.6 Graves

- The player picks the chain (NEAR or Solana) and pastes the token address.
  - **NEAR:** the server reads name, symbol and logo with `ft_metadata`.
  - **Solana:** Solana RPC `getAccountInfo` checks it is an SPL or Token-2022 mint. Name, ticker and logo come from Jupiter's token list, with Token-2022 metadata as a fallback.
- Logos are downloaded once by the server, checked and converted to a 128 px WebP, so the browser never loads images from other sites.
- Last words: 1 to 100 characters, shown live on the preview.
- Price: one USD price for every grave (`GRAVE_PRICE_USD`, $1 at launch), sent in NEAR at the live price.
- One grave per memecoin contract, ever. Graves cannot be removed.
- The creator gets the grave's first Memorial NFT (#001).

### 4.7 Gifts and levels

| Gift | Price | EXP |
|---|---|---|
| Candle | $0.10 | 1 |
| Flowers | $0.20 | 2 |
| Instant noodles | $0.50 | 5 |
| Copium tank | $1 | 12 |
| A rug | $3 | 40 |
| Diamond hands | $10 | 150 |

Prices and EXP are fixed in `shared/graves.ts`; the server prices every gift itself.

| Level | Name | EXP needed | Tombstone |
|---|---|---|---|
| 1 | Forgotten Grave | 0 | Wooden cross |
| 2 | Remembered Grave | 25 | Headstone |
| 3 | Honored Grave | 250 | Marble tomb |
| 4 | Legendary Grave | 2,500 | Mausoleum |

- Each verified payment adds exactly one gift with that gift's EXP (enforced by a unique key in the database).
- Failed, underpaid, reused or repeated confirmations never count.
- Changes are pushed live to everyone (`grave_updated`).

### 4.8 Memorial NFTs

- **Who gets one:** the grave's creator (#001), and every wallet on its first gift to that grave. Exactly one per wallet per grave, enforced by the database and by the contract.
- **Title:** `$RUG Memorial #001`, numbered per grave.
- **Live artwork and metadata:** the contract stores relative links (`grave/<id>/media.svg`, `token/<id>.json`) under its `base_uri` (`<PUBLIC_BASE_URL>/nft`). The game serves those live, so every memorial of a grave evolves together. The artwork shows the grave's current level design with the token logo, ticker and EXP.
- **Attributes:** memecoin name and contract, chain, grave id, level, total community gifts, original wallet, personal gifts made, first gift date, grave creation date.
- **Minting:** done by the server (`server/src/minter.ts`) with a key that can only call `mint_memorial`. It checks `memorial_of` before every mint, so a retry can never double-mint. Failures back off (30 s up to 30 min); after 10 tries the memorial is marked `failed` and logged.
- **Until the contract is deployed**, gifts still work and memorials are queued as pending; the UI says minting is not switched on yet, and they mint in order once it is.
- **Contract:** `contracts/memorial/src/lib.rs`, Rust, near-sdk 5.29, standards NEP-171 (core), NEP-177 (metadata), NEP-178 (approvals) and NEP-181 (enumeration). The contract pays NFT storage from its own balance (about 0.01 NEAR per memorial).

### 4.9 Buyback rounds (for $WTH holders)

Built and tested, switched off until the buyback account exists.

1. All grave and gift revenue (NEAR) collects in a dedicated buyback account.
2. Every 10 minutes the server checks it. When the NEAR above a small reserve is worth $20 (`BUYBACK_THRESHOLD_USD`), a round runs.
3. 20% (`BUYBACK_TEAM_PERCENT`) goes to `whatthehoot.near`.
4. The rest buys WTH on Ref Finance's WTH/NEAR DCL pool, with a 2% minimum-output limit.
5. The WTH bought is shared with holders in proportion to their holdings, in batches of 35 transfers. Holders under 100,000 WTH, pools, exchanges and project wallets are left out.

Safety: every step is recorded before it is sent. A definite failure is retried next round. An unknown outcome (for example an RPC timeout after sending) stops everything as `needs_check` until someone looks. History is public at `/api/buybacks` and in the explainer.

---

## 5. Payment workflow (graves and gifts)

There is no smart contract in the payment path: a payment is a plain NEAR transfer to the treasury that the server verifies on chain.

```
Player                 Browser (game)                Game server                    NEAR
  |  press E, choose      |                               |                            |
  |---------------------->|  POST /api/payments           |                            |
  |                       |  or /api/offerings            |                            |
  |                       |------------------------------>| price in USD -> NEAR at     |
  |                       |                               | live price + unique tail;  |
  |                       |                               | hold plot + meme 15 min    |
  |                       |<------------------------------| order id + exact amount    |
  |  approve in wallet    |  wallet sends NEAR transfer   |                            |
  |---------------------->|------------------------------------------------------------>|
  |                       |  tx hash saved in browser     |                            |
  |                       |  POST /payments/:id/confirm   |                            |
  |                       |------------------------------>| check tx: final, success,  |
  |                       |                               | signer, receiver = treasury|
  |                       |                               | exact amount, after order  |
  |                       |                               |--------------------------->|
  |                       |                               | create grave / gift in one |
  |                       |                               | DB transaction; queue NFT  |
  |                       |<------------------------------| fulfilled; broadcast live  |
```

Key rules:

- **Live price.** NEAR/USD from CoinGecko, then Coinbase, Kraken, Binance; cached for a minute. If nothing has answered for 15 minutes, new orders pause with a clear message instead of guessing. Prices outside $0.01 to $10,000 are rejected.
- **Unique amount.** A plain transfer cannot carry a memo, so every order gets the price plus a random tail under 0.000001 NEAR. That is how the server knows which order a transfer belongs to, and one transfer can never be claimed by another order.
- **One hash, one use.** A transaction hash can only ever count once.
- **Holds.** A grave order holds its plot and memecoin for `HOLD_MINUTES` (15). Max 2 open holds per IP; max 3 open gifts per browser and 10 per IP.
- **Browser ownership.** Every browser has its own random session id (`x-rip-session`). Orders can only be resumed, cancelled or confirmed from the browser that made them.
- **Recovery.** The sent transaction hash is saved in the browser the moment the wallet returns it. After a refresh, a lost confirm or a wallet redirect, the game confirms that same transfer instead of asking for a second one.
- **Background sweep (every 15 s).** Expires unpaid holds and re-checks interrupted verifications. A made-up hash that NEAR never sees frees its plot 10 minutes after the hold ends, but is still re-checked, so a real late transfer still creates the grave.
- **Every state is handled in the UI:** not connected, connecting, not enough balance, waiting for approval, sent, confirming, done, cancelled in wallet, failed, network error, hold expired, slow confirmation, recovery.
- **Refunds are manual.** If a valid grave payment arrives after its hold expired and someone else took the plot or coin, it is marked `unfulfillable` and logged as `PAID BUT UNFULFILLABLE`.

---

## 6. Strategy

### Product

- **Make losing funny.** Everyone in crypto has a dead coin. The graveyard turns that into a shared joke and a place to hang out, with silly walks, crying emotes and copium tanks.
- **Social first.** Real-time players, chat, ghosts that join your emotes, live announcements. The world never feels empty, even with one player.
- **Community progress.** Graves belong to nobody; everyone levels them up together. That gives people a reason to come back and bring friends for "their" coin.
- **Collectible proof.** Memorial NFTs reward participation and evolve as the grave grows, so early supporters' NFTs get better over time.

### Pricing

- Low prices to keep it impulse-friendly: $1 per grave, gifts from $0.10 to $10.
- Prices in USD so they stay stable, collected in NEAR.
- The cheapest gift must stay above the ~0.01 NEAR storage cost of a new Memorial NFT.

### Money flow

- Revenue goes to the treasury (`whatthehoot.near`) at launch.
- When buybacks are switched on, revenue goes to the buyback account: 20% to the team, 80% buys $WTH that is shared with holders. Every round is public. A legal check is needed before announcing revenue sharing.

### Chain choice

- NEAR mainnet for all payments and the NFT contract (cheap, fast, named accounts).
- Solana memecoins are supported for graves because that is where most memecoins die; they are still paid in NEAR.

### Rollout

1. Launch the game with graves and gifts (memorials queue).
2. Deploy the Memorial NFT contract (testnet first), then switch on minting; queued memorials mint in order.
3. Switch on buybacks after a legal check.
4. Later: search, more chains, more plots, moderation.

---

## 7. Technical architecture

### Stack

| Layer | Technology |
|---|---|
| Client | Vite 6, TypeScript, three.js, Web Audio |
| Wallet | NEAR Wallet Selector 10.1.4 (MyNearWallet, Meteor, HERE), loaded only when needed |
| Server | Node 24 running TypeScript directly (Node >= 22.18), `ws` for WebSockets |
| Database | SQLite via Node's built-in `node:sqlite`, migrations (now version 5) |
| Images | sharp 0.35.5 (logo conversion, NFT artwork) |
| Contract | Rust, near-sdk 5.29, wasm32 |
| Tests | vitest |

### Code layout

```
shared/protocol.ts     wire protocol + validation (client and server)
shared/graves.ts       plots, levels, gifts, chains, API shapes, USD -> yoctoNEAR
server/src/
  index.ts             entry point
  config.ts            environment configuration
  server.ts            HTTP (static files, /healthz, /api, /nft), WebSocket, rate limits, security headers
  rooms.ts             rooms and players (pure logic)
  names.ts             random silly names
  db.ts                SQLite + migrations
  graves.ts            graves, gifts, holds, payment confirmation, expiry, EXP, levels, memorial queue
  api.ts               JSON API, rate limiter, browser session header
  near.ts              NEAR RPC: metadata, transfer verification, balances
  solana.ts            Solana mint lookup, safe logo download and conversion
  price.ts             live NEAR/USD price
  minter.ts            Memorial NFT minting
  nft.ts               live NFT metadata JSON and artwork
  buyback.ts           buyback rounds
  log.ts               structured JSON logs
client/src/
  main.ts              app start, payment recovery
  world/               graveyard, plots, tombstones, collisions
  owl/                 owl model, toon shading, animations
  game/                player, input, camera, ghost NPCs
  net/                 connection state machine, remote players, API client
  audio/               music and sounds
  wallet/              wallet selector
  ui/                  HUD, landing, tutorial, chat, plot card, dig-a-grave and gift dialogs, shared payment flow, buyback history
contracts/memorial/    Memorial NFT contract
scripts/               demo graves (local only), docs art
server/test, client/test   automated tests
```

### HTTP and WebSocket endpoints

| Route | Purpose |
|---|---|
| `GET /healthz` | Health check |
| `GET /ws` (upgrade) | Multiplayer WebSocket |
| `GET /api/config` | Prices, gifts, chains, wallet settings |
| `GET /api/graves`, `GET /api/graves/:id` | All graves; one grave with the wallet's memorial status |
| `GET /api/meme?chain=&contract=` | Look up a memecoin's name, ticker, logo |
| `GET /api/balance?account=` | NEAR balance check |
| `POST /api/payments` | New grave order (hold) |
| `POST /api/offerings` | New gift order |
| `GET /api/payments/:id` | Order status |
| `POST /api/payments/:id/confirm` | Confirm with a transaction hash |
| `POST /api/payments/:id/cancel` | Cancel an open order |
| `GET /api/buybacks` | Public buyback history |
| `GET /nft/token/:id.json` | Live Memorial NFT metadata |
| `GET /nft/grave/:id/media.svg` | Live Memorial NFT artwork |
| `GET /nft/preview.svg` | Artwork preview while digging a grave |

### Networks

Everything runs on **mainnet**: the wallet is fixed to NEAR mainnet, RPCs default to fastnear and near.org, Solana uses mainnet-beta. There is no testnet switch in the game (the contract can still be trialled on testnet with the CLI).

---

## 8. Security

### Built-in protections

- WebSocket origin allow-list, connection cap, 1 KB message limit, token-bucket rate limits, ping/pong heartbeats, malformed messages count toward disconnect.
- Server-side movement clamping (bounds, speed, hop height).
- Chat cleaning and rate limits.
- Security headers on every response.
- Keys only from environment variables (`MINTER_PRIVATE_KEY`, `BUYBACK_PRIVATE_KEY`), never in the repo. The minter key can only call `mint_memorial`.
- Idempotent payments, unique amounts, one-use hashes, one DB transaction per fulfilment.

### Audit of 11 Nov 2026 (S01 to S08), all fixed in `e066786`

| Fix | What changed |
|---|---|
| Wallet popup safety | Intear wallet removed (issue in its adapter); `cross-origin-opener-policy: same-origin-allow-popups` header |
| Logo fetching cannot reach private networks | https on port 443 only, no IP literals, no local names, every resolved address checked against private ranges (also IPv4 hidden in IPv6), every redirect re-checked, DNS answer pinned for the connection |
| Memory limits | Downloads streamed and cut off at the size cap whatever they claim |
| Image decoding | Only PNG, JPEG, GIF, WebP and SVG, told apart by their bytes; risky sharp loaders blocked; max 4 logo jobs at once with a queue of 16; coin preview rate-limited |
| Shared IP orders | Orders belong to the browser that made them (`x-rip-session`), not to the IP |
| Double sends | The sent transaction is saved in the browser and reused after a lost confirm, reload or double click |
| Fake hashes holding plots | Unseen hashes release the plot 10 min after the hold ends and count toward the hold limit; live verifications capped at 8 |
| Static file escape | Paths checked by whole path parts; encoded backslashes and null bytes refused |

Remaining note: `npm audit` reports 9 high entries inside the Meteor and HERE wallet SDKs; npm's only offered fix is a major downgrade, so nothing was applied.

---

## 9. Testing

- `npm run check`: typecheck for client and server, then all tests.
- **99 tests in 11 files, all passing**: protocol, rooms, names, chat, graves, gifts, levels, payment flow, minting, NFT artwork and metadata, migrations, NEAR verification, Solana lookup and safe fetching, buybacks, static files, HTTP and WebSocket integration (two real players joining and seeing each other), and the compiled NFT contract run against a mocked NEAR host.
- Manually checked in real browsers: multiplayer, reconnect, dialogs, demo graves at all 4 levels, real Solana logos converted, build contents.
- **Not yet verified:** a real wallet payment on mainnet, and the contract on a real network.

---

## 10. How to run it

```bash
npm install
npm run build        # client into dist/client
npm start            # server on http://localhost:8787
```

Development: `npm run dev:server` and `npm run dev:client` (Vite on :5173). Demo graves for local viewing only: `node scripts/demo-grave.ts` (and `--remove`).

---

## 11. Going live

### Required

1. Push to GitHub.
2. Host on Railway: Node 24, build `npm ci && npm run build`, start `npm start`, a persistent volume at `/data`.
3. Point `whatthehoot.lol` at it (HTTPS and wss come with it).
4. Environment: `NODE_ENV=production`, `ALLOWED_ORIGINS=https://whatthehoot.lol`, `DB_PATH=/data/rip.sqlite`, `TREASURY_ACCOUNT=whatthehoot.near`, `GRAVE_PRICE_USD=1`, `TRUST_PROXY=1`, `ROOM_CAPACITY=50`, `MAX_ROOMS=1`. Do not set `OFFERING_MIN_USD` (the server refuses to start with it).
5. Test on phone and laptop with each wallet, then make one real $0.10 candle gift and one $1 grave.
6. Decide the refund process for `unfulfillable` payments.

### After launch

- Database backups and uptime monitoring on `/healthz`.
- Memorial NFT contract: testnet trial, then `memorial.whatthehoot.near` and `minter.whatthehoot.near`, then set `NFT_CONTRACT`, `MINTER_ACCOUNT_ID`, `MINTER_PRIVATE_KEY`, `PUBLIC_BASE_URL`.
- Buybacks: `buyback.whatthehoot.near` with about 1 NEAR, legal check first.
- Chat moderation, terms and privacy pages, load test.

---

## 12. Known limits

- Player sessions are in memory; a server restart reconnects everyone as new players. Graves, gifts, memorials and payments survive in SQLite.
- One server process; scaling out would need sticky sessions or a shared room service.
- Movement is client-predicted; a modified client could walk through gravestones (not out of the world).
- Memorial artwork and metadata are served by the game server; if it is down, wallets cannot load them (ownership on chain is unaffected).
- Prices depend on public NEAR/USD feeds.
- Names are not identities.
- The JS bundle is about 620 KB (170 KB gzipped), mostly three.js.

---

## 13. History

47 commits, from the first multiplayer graveyard to today. Main milestones in order:

1. Multiplayer graveyard: rooms, synced owls, reconnect, tests.
2. Emotes, chat, snapshot, intro scene and explainer.
3. Graves, then gifts, memorial levels and the Memorial NFT contract.
4. Payments moved to plain NEAR transfers with USD prices and unique amounts.
5. Music, sound effects and the provided audio tracks.
6. Buyback rounds and launch prices.
7. NPC owls, later turned into ghost owls with coin logos.
8. Solana memecoins, tutorial, game-style dialogs, gifts with fixed prices and EXP.
9. Creator gets Memorial NFT #001.
10. Security fixes from the 11 Nov audit.
