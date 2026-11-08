# REST IN PUMP

A multiplayer cartoon graveyard. Players walk around as the owl mascot and see each other in real time.

## Status

| Area | State |
|---|---|
| 3D world + owl character | Done (ported from the prototype, unchanged look) |
| Multiplayer (rooms, sync, reconnect) | **Done — phase 1** (see "What is verified") |
| Graves: create a grave for a meme on an empty plot, paid in WTH, verified on NEAR | **Built** — server tested; a real-wallet payment has not been made through the game yet |
| Offerings, memorial levels (graves evolve with the community offering count) | **Built** — same payment flow, server + browser tested |
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

A local copy starts with an empty graveyard. To see graves, add four clearly labelled demo graves, one per level (plots 37, 36, 29, 28 by the path near the gate; not real memes, nobody paid for them, offering counts set for display), and remove them when you are done. Never run it against the production database.

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
  graves.ts            graves + offerings: holds, payment confirmation, idempotency, expiry, offering count, memorial queue
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
- The player pastes a NEAR token contract; the server reads name, symbol and logo with `ft_metadata`. Only inline
  `data:` logos are shown (remote image URLs are ignored for safety).
- One price for every grave (`GRAVE_PRICE_WTH`, a fixed WTH amount — update it when the WTH price moves). Last words:
  1–100 characters. One grave per meme contract, ever. Graves cannot be removed.
- Creating a grave does **not** mint an NFT. The creator gets a memorial by making an offering like anyone else.

**Offerings**
- At a grave, **E** opens "Leave an offering": a funny item (candle, flowers, instant noodles, a rug, diamond hands,
  copium tank) plus any WTH amount of at least `OFFERING_MIN_WTH` (10,000).
- The grave's **community offering count** is the number of successful offerings — not WTH spent. Each verified
  payment adds exactly one (one payment row → at most one offering row, enforced by a unique key). Failed,
  underpaid, reused or repeated confirmations never count.
- Levels: 1 Forgotten Grave (0–9), 2 Remembered (10–99), 3 Honored (100–999), 4 Legendary (1,000+). The tombstone in
  the world changes design with the level (wooden cross → headstone → marble tomb → mausoleum) and the latest
  offerings are laid in front of it. Changes are pushed live to everyone (`grave_updated`).

**Payments (graves and offerings)**
- The server creates the payment and returns the exact transfer. A grave payment also **holds** the plot and the meme
  for `HOLD_MINUTES`. The player sends an `ft_transfer` of WTH to `TREASURY_ACCOUNT` with memo `rip:<paymentId>`
  from their own wallet. The server verifies the NEP-141 `ft_transfer` event on NEAR (token, receiver, sender,
  memo, amount, final and successful), then creates the grave / records the offering in one database transaction.
  A transaction hash can only ever be used once.
- A background job (every 15 s) expires unpaid holds and re-checks payments whose verification was interrupted.
- **Refunds are manual.** If a valid grave payment arrives after its hold expired *and* someone else took the plot
  or the meme meanwhile, it is marked `unfulfillable` and logged at error level (`PAID BUT UNFULFILLABLE`).
  Find them with: `SELECT * FROM payments WHERE status = 'unfulfillable';`

**Memorial NFTs**
- A wallet's first successful offering to a grave queues that grave's Memorial NFT for the wallet that actually
  signed the payment. Exactly one per wallet per grave, however many offerings it makes (unique in the database
  *and* enforced by the contract). Title: `$RUG — Memorial #001` (numbered per grave).
- The contract (`contracts/memorial`) stores `media = grave/<id>/media.svg` and `reference = token/<id>.json`,
  relative to its `base_uri` (`<PUBLIC_BASE_URL>/nft`). The game serves those live, so every memorial of a grave
  evolves together: the artwork shows the grave's current level, ticker and offering count, and the JSON carries
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

## Known limits / risks

- Player sessions are in memory: a server restart drops them (clients reconnect as new players). Graves, offerings,
  memorials and payments are in SQLite (`DB_PATH`, default `data/rip.sqlite`) and survive restarts. Put it on a
  persistent disk and back it up.
- The payment verifier is tested against NEAR's documented response format, not yet against a real payment made
  through the game. Make one small real offering (10,000 WTH) before launch.
- The Memorial NFT contract is tested by running the compiled wasm against a mocked NEAR host (`contract.test.ts`),
  and the minter against a fake chain. It has not been deployed yet; run the testnet trial above first.
- Memorial metadata is served by this game server; if it is down, wallets can't load the artwork/attributes
  (the on-chain title, owner and transfer history are unaffected).
- WTH trades on a thin pool; fixed prices avoid manipulation but must be updated by hand.
- One server process. Horizontal scaling would need sticky sessions or a shared room service.
- Movement is client-predicted; the server limits speed and bounds but does not check collisions with
  gravestones, so a modified client can walk through scenery (not through the world edge).
- No accounts: every player gets a random silly name from the server on join (unique among players online,
  not changeable). Names are not identities.
- The JS bundle is ~620 KB (170 KB gzipped), mostly three.js.
