# REST IN PUMP

A multiplayer cartoon graveyard. Players walk around as the owl mascot and see each other in real time.

## Status

| Area | State |
|---|---|
| 3D world + owl character | Done (ported from the prototype, unchanged look) |
| Multiplayer (rooms, sync, reconnect) | **Done — phase 1** (see "What is verified") |
| Graves: create a grave for a meme on an empty plot, paid in NEAR ($1 at the live price), verified on chain | **Built** — server tested; a real-wallet payment has not been made through the game yet |
| Offerings, memorial levels (graves evolve with community EXP from gifts) | **Built** — same payment flow, server + browser tested |
| Memorial NFTs (NEP-171 contract + server minter + live metadata/artwork) | **Built, not deployed** — contract tested as compiled wasm; deploy to `memorial.whatthehoot.near` is yours (below) |
| Grave search, memes on other chains (Solana / Base / Ethereum) | Not started |

The HUD only shows controls that work. Grave search will appear when it exists end to end.

## Run it

Requires Node 22.18+ (the server runs TypeScript directly via Node's type stripping — no build step for it).

```bash
npm install
npm run build        # builds the client into dist/client
npm start            # game server on http://localhost:8787 (serves the built client + WebSocket at /ws)
```

Development with hot reload (two terminals):

```bash
npm run dev:server   # :8787, restarts on change
npm run dev:client   # Vite on :5173, proxies /ws to the server
```

Checks:

```bash
npm run check        # typecheck client + server, then run the tests
npm run contract:build   # build the Memorial NFT contract (needs Rust + the wasm32 target); its tests then run in npm test
```

A local copy starts with an empty graveyard. To see graves, add four clearly labelled demo graves, one per level (plots 37, 36, 29, 28 by the path near the gate; not real memes, nobody paid for them, EXP set for display), and remove them when you are done. Never run it against the production database.

```bash
node scripts/demo-grave.ts            # add
node scripts/demo-grave.ts --remove   # remove
```

## Layout

```
shared/protocol.ts     wire protocol + validation, shared by client and server
shared/graves.ts       plots, memorial levels, offering items, grave/payment/memorial API shapes, message rules
server/src/            game server (Node + ws)
  config.ts            env configuration (see .env.example)
  rooms.ts             room / player bookkeeping, pure logic (unit-tested)
  server.ts            HTTP (static files, /healthz, /api) + WebSocket handling, rate limits, heartbeats
  db.ts                SQLite (Node's built-in driver) + migrations
  graves.ts            graves + offerings: holds, payment confirmation, idempotency, expiry, gift EXP + levels, memorial queue
  minter.ts            mints queued Memorial NFTs on NEAR (idempotent, retries with backoff)
  nft.ts               live NFT metadata (/nft/token/:id.json) and level-based artwork (/nft/grave/:id/media.svg)
  near.ts              NEAR RPC: token metadata, ft_transfer verification
  api.ts               JSON API for graves, offerings and payments
  log.ts               structured JSON logging
server/test/           vitest: protocol, rooms, graves, offerings, minting, artwork, migration, NEAR verification,
                       HTTP + WebSocket integration, and the compiled NFT contract (contract.test.ts)
contracts/memorial/    Memorial NFT contract (Rust, near-sdk 5.29, NEP-171/177/178/181)
client/                Vite app
  src/world/           the graveyard (seeded, identical for every player), grave plots + tombstones, collisions
  src/owl/             owl model (built once, shared) + animation / weird walks
  src/game/            local player, input, camera
  src/net/             connection state machine, remote players + interpolation, grave API client
  src/audio/           music + sound effects, synthesized with Web Audio (no audio files)
  src/wallet/          NEAR wallet selector (loaded only when needed)
  src/ui/              HUD, intro, chat, plot card, create-grave + offering dialogs (shared flow), name tags
brand/                 original logo artwork (client/public has the cropped icon sizes)
prototype/             the original single-file prototype (reference only)
TODO.md                roadmap checklist
```

## Multiplayer design

- The server is the source of truth for who is online, rooms, names, and positions it accepts.
- Clients send their state at 15 Hz (only when it changes). The server clamps every update: inside the
  world, no faster than run speed (with jitter slack), sane hop height, valid walk style.
- The server broadcasts compact room snapshots at 15 Hz. Clients draw others 120 ms in the past and
  interpolate between snapshots.
- Everyone shares one graveyard (`MAX_ROOMS=1`, `ROOM_CAPACITY=50`). The server can still split players into
  several instances if `MAX_ROOMS` is raised, but the game UI has no room picker.
- A dropped player keeps their slot, id and name for `RECONNECT_GRACE_MS`. The session token lives in
  `sessionStorage`, so a refresh or network blip resumes the same player; a duplicated tab gets a new one.
- Every player gets a random silly name and a random walk style from the server on join; neither can be changed.
- Emotes (dance, club, pray, cry, roll) are part of the synced player state.
- Chat is relayed by the server to the room: cleaned (no control/zero-width characters), max 140 chars,
  rate-limited (burst of 3, then one per 1.5 s). There is no chat history or moderation yet.
- Abuse limits: 1 KB max message, token-bucket rate limit (40/s, burst 60), malformed messages counted
  toward disconnect, origin allow-list on the WebSocket, connection cap, ping/pong heartbeat.

## What is verified

- `npm run check`: typecheck clean; 63 tests pass (4 of them run the compiled NFT contract; they skip if it is not built), including real WebSocket sessions for two players
  joining and seeing each other move, resume within the grace period, timeout after it, room capacity
  and overflow, room switching, outdated-client rejection, malformed input, foreign origins, renaming,
  and the health check.
- Manually in two browser sessions against the production build: both players see each other, walking
  animation and walk style sync, server-assigned and changed names propagate, the online count comes from
  the server, refreshing resumes the same player, and auto-reconnect after a server restart.

## Graves, offerings and Memorial NFTs

"Every offering keeps the memory alive." A grave represents a memecoin; nobody owns it.

**Graves**
- 40 plots (5 rows x 8, `shared/graves.ts`). Walking up to one highlights the whole plot; **E** opens "Create a grave".
- The player picks NEAR or Solana and pastes the token address. Payment is always in NEAR.
  - NEAR: the server reads name, symbol and logo with `ft_metadata`. Only inline `data:` logos are shown.
  - Solana (`server/src/solana.ts`): Solana RPC `getAccountInfo` checks it is an SPL / Token-2022 mint and gives decimals;
    name, ticker and logo come from Jupiter's token list (Token-2022 metadata as a fallback). The logo link is downloaded
    once by the server (public https only, 4 MB cap, IPFS via several gateways) and stored as a 128 px WebP, so the
    browser never loads images from other sites. RPC endpoints: `SOLANA_RPC_URLS`.
- One price for every grave in USD (`GRAVE_PRICE_USD`, default $1), paid in NEAR at the live NEAR price. Last words:
  1–100 characters. One grave per meme contract, ever. Graves cannot be removed.
- The creator gets the grave's **first Memorial NFT (#001)**, queued the moment the grave is created; everyone else earns one with their first gift.

**Offerings**
- At a grave, **E** opens "Leave a gift". Every gift has a fixed USD price (paid in NEAR at the live price) and gives
  the grave EXP (`OFFERING_ITEMS` in `shared/graves.ts`):

  | Gift | Price | EXP |
  |---|---|---|
  | Candle | $0.10 | 1 |
  | Flowers | $0.20 | 2 |
  | Instant noodles | $0.50 | 5 |
  | Copium tank | $1 | 12 |
  | A rug | $3 | 40 |
  | Diamond hands | $10 | 150 |

  The cheapest gift must stay above the ~0.01 NEAR each new Memorial NFT costs in storage.
- A grave's **level comes from its community EXP**: Level 2 at 25 EXP, Level 3 at 250, Level 4 at 2,500. The server
  prices each gift itself, and each verified payment adds exactly one offering with that gift's EXP (one payment row →
  at most one offering row, enforced by a unique key). Failed, underpaid, reused or repeated confirmations never count.
- Levels: 1 Forgotten Grave (0–9), 2 Remembered (10–99), 3 Honored (100–999), 4 Legendary (1,000+). The tombstone in
  the world changes design with the level (wooden cross → headstone → marble tomb → mausoleum) and the latest
  offerings are laid in front of it. Changes are pushed live to everyone (`grave_updated`).

**Payments (graves and offerings)**
- Prices are set in USD and paid in **NEAR**. The server converts at the live NEAR/USD price (CoinGecko, then
  Coinbase, Kraken, Binance; cached for a minute). If no source has answered for 15 minutes, new orders pause with a
  clear message instead of charging a guessed amount. Amounts are rounded up to 0.000001 NEAR.
- The server creates the order and returns the exact amount. A grave order also **holds** the plot and the meme for
  `HOLD_MINUTES`. The player's wallet sends a plain NEAR transfer to `TREASURY_ACCOUNT`.
- A plain transfer can't carry a memo, so every order gets a **unique exact amount**: the price plus a random tail
  under 0.000001 NEAR. The server checks on chain that the transaction is final and successful, signed by the
  player, sent to the treasury, for exactly that amount, and made after the order was created. Then it creates the
  grave / records the offering in one database transaction. A transaction hash can only ever be used once, and a
  transfer can't be claimed by someone else's order (the amounts differ).
- A background job (every 15 s) expires unpaid holds and re-checks payments whose verification was interrupted.
- **Refunds are manual.** If a valid grave payment arrives after its hold expired *and* someone else took the plot
  or the meme meanwhile, it is marked `unfulfillable` and logged at error level (`PAID BUT UNFULFILLABLE`).
  Find them with: `SELECT * FROM payments WHERE status = 'unfulfillable';`

**Memorial NFTs**
- A wallet's first successful offering to a grave queues that grave's Memorial NFT for the wallet that actually
  signed the payment. Exactly one per wallet per grave, however many offerings it makes (unique in the database
  *and* enforced by the contract). Title: `$RUG Memorial #001` (numbered per grave).
- The contract (`contracts/memorial`) stores `media = grave/<id>/media.svg` and `reference = token/<id>.json`,
  relative to its `base_uri` (`<PUBLIC_BASE_URL>/nft`). The game serves those live, so every memorial of a grave
  evolves together: the artwork shows the grave's current level, ticker and EXP, and the JSON carries
  the attributes (memecoin name and contract, blockchain, grave ID, memorial level, total community offerings,
  original participant wallet, personal offerings made, first offering date, grave creation date).
- Memorials are normal transferable NFTs. No staking, yield, rewards or token burning.
- Minting is done by the server (`server/src/minter.ts`) with the minter account's key. It checks `memorial_of`
  before every mint, so retries can never double-mint; failures back off (30 s → 30 min) and after 10 tries the
  memorial is marked `failed` and logged (`MEMORIAL MINT FAILED`). Retry those with:
  `UPDATE memorials SET status = 'pending', attempts = 0, next_attempt_at = 0 WHERE status = 'failed';`
- If `NFT_CONTRACT` / `MINTER_ACCOUNT_ID` / `MINTER_PRIVATE_KEY` are not set, offerings still work and memorials
  are recorded as pending; the UI says minting is not switched on yet, and they mint once it is.
- The contract pays NFT storage from its own balance (~0.01 NEAR per memorial). Keep it funded.

### Deploying the Memorial NFT contract (you)

Try it on testnet first (same steps with `.testnet` accounts and `network-config testnet`). These use
[near-cli-rs](https://github.com/near/near-cli-rs); run `near` with no arguments for the interactive version if a
flag differs in your CLI version.

```bash
npm run contract:build
# 1. the contract account (~3 NEAR covers the code; add ~0.01 NEAR per expected memorial)
near account create-account fund-myself memorial.whatthehoot.near '5 NEAR' autogenerate-new-keypair save-to-keychain sign-as whatthehoot.near network-config mainnet sign-with-keychain send
# 2. a separate minter account the server signs with (pays gas only)
near account create-account fund-myself minter.whatthehoot.near '1 NEAR' autogenerate-new-keypair save-to-keychain sign-as whatthehoot.near network-config mainnet sign-with-keychain send
# 3. deploy + initialise (owner = whatthehoot.near can change the minter and base_uri later)
near contract deploy memorial.whatthehoot.near use-file contracts/memorial/target/wasm32-unknown-unknown/release/rip_memorial.wasm with-init-call new json-args '{"owner_id":"whatthehoot.near","minter_id":"minter.whatthehoot.near","base_uri":"https://YOUR-DOMAIN/nft"}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' network-config mainnet sign-with-keychain send
# 4. a key for the server that can ONLY call mint_memorial (limits damage if the server is compromised)
near account add-key minter.whatthehoot.near grant-function-call-access --allowance '1 NEAR' --contract-account-id memorial.whatthehoot.near --function-names mint_memorial autogenerate-new-keypair print-to-terminal network-config mainnet sign-with-keychain send
```

Then set `NFT_CONTRACT=memorial.whatthehoot.near`, `MINTER_ACCOUNT_ID=minter.whatthehoot.near`,
`MINTER_PRIVATE_KEY=<the ed25519 key printed in step 4>` and `PUBLIC_BASE_URL=https://YOUR-DOMAIN` in the server's
environment (never commit the key). On start the minter checks that the contract's `get_minter` matches.
The build needs `--cfg near` (set in `contracts/memorial/.cargo/config.toml`); for a reproducible, verifiable
build you can use `cargo near build` instead.

## Buyback rounds (revenue -> $WTH holders)

All grave and offering revenue (NEAR) goes to a dedicated buyback account. Every 10 minutes the server checks it;
when the NEAR above a small reserve is worth `BUYBACK_THRESHOLD_USD` ($20), it runs a round (`server/src/buyback.ts`):

1. `BUYBACK_TEAM_PERCENT` (20%) goes to `BUYBACK_TEAM_WALLET` (whatthehoot.near).
2. The rest buys WTH on RHEA's WTH/NEAR DCL pool (`wrap.near|wth-0b2227.launchpad.justhoot.near|10000`):
   wrap NEAR, then `ft_transfer_call` to `dclv2.ref-labs.near` with a `Swap` message and a 2% minimum-output limit.
3. The WTH bought is sent to holders in proportion to their holdings, in batches of 35 `ft_transfer`s. Holder list:
   FastNear's top holders. Left out: holders below `BUYBACK_MIN_HOLDING_WTH` (100,000), the RHEA pools,
   `intents.near`, the justhoot launchpad / router / token contracts, the buyback account and the team wallet,
   plus anything in `BUYBACK_EXCLUDE`. (root.near is a holder and is included.)

Safety: every step is recorded before it is sent. A definite failure is retried next time; an **unknown outcome**
(e.g. an RPC timeout after sending) stops the round as `needs_check` and no new round starts until someone has
looked (`SELECT * FROM buyback_rounds WHERE status = 'needs_check'`). If the holder list could be cut off above the
minimum holding, the round stops instead of paying an incomplete list. Everything is public at `/api/buybacks`
and in "What is Rest In Pump?" -> "How it helps $WTH".

Set up (you):
```bash
# a separate account that only does buybacks (fund it with ~1 NEAR for gas + storage; that reserve is never spent)
near account create-account fund-myself buyback.whatthehoot.near '1 NEAR' autogenerate-new-keypair print-to-terminal sign-as whatthehoot.near network-config mainnet sign-with-keychain send
```
Then set `TREASURY_ACCOUNT=buyback.whatthehoot.near`, `BUYBACK_ACCOUNT_ID=buyback.whatthehoot.near` and
`BUYBACK_PRIVATE_KEY=ed25519:...` (the key printed above; it needs full access because it sends NEAR and tokens).
Keep only revenue + the small reserve in this account. Sharing revenue with token holders can have legal
consequences in some countries; get advice before announcing it.

## Known limits / risks

- Player sessions are in memory: a server restart drops them (clients reconnect as new players). Graves, offerings,
  memorials and payments are in SQLite (`DB_PATH`, default `data/rip.sqlite`) and survive restarts. Put it on a
  persistent disk and back it up.
- The payment verifier is tested against NEAR's documented response format, not yet against a real payment made
  through the game. Make one small real offering ($0.10 in NEAR) before launch.
- The Memorial NFT contract is tested by running the compiled wasm against a mocked NEAR host (`contract.test.ts`),
  and the minter against a fake chain. It has not been deployed yet; run the testnet trial above first.
- Memorial metadata is served by this game server; if it is down, wallets can't load the artwork/attributes
  (the on-chain title, owner and transfer history are unaffected).
- Prices depend on public NEAR/USD feeds; a wrong feed would mis-price orders (the server rejects prices outside $0.01–$10,000).
- One server process. Horizontal scaling would need sticky sessions or a shared room service.
- Movement is client-predicted; the server limits speed and bounds but does not check collisions with
  gravestones, so a modified client can walk through scenery (not through the world edge).
- No accounts: every player gets a random silly name from the server on join (unique among players online,
  not changeable). Names are not identities.
- The JS bundle is ~620 KB (170 KB gzipped), mostly three.js.
