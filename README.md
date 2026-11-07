# REST IN PUMP

A multiplayer cartoon graveyard. Players walk around as the owl mascot and see each other in real time.

## Status

| Area | State |
|---|---|
| 3D world + owl character | Done (ported from the prototype, unchanged look) |
| Multiplayer (rooms, sync, reconnect) | **Done — phase 1** (see "What is verified") |
| Graves: plots, burying, 4 tombstone tiers, WTH payment verified on NEAR | **Built** — server tested; a real-wallet payment has not been made through the game yet |
| Offerings | Next |
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
```

## Layout

```
shared/protocol.ts     wire protocol + validation, shared by client and server
shared/graves.ts       plots, tiers, grave/payment API shapes, message rules
server/src/            game server (Node + ws)
  config.ts            env configuration (see .env.example)
  rooms.ts             room / player bookkeeping, pure logic (unit-tested)
  server.ts            HTTP (static files, /healthz, /api) + WebSocket handling, rate limits, heartbeats
  db.ts                SQLite (Node's built-in driver) + migrations
  graves.ts            grave holds, payment confirmation, idempotency, expiry (unit-tested)
  near.ts              NEAR RPC: token metadata, ft_transfer verification
  api.ts               JSON API for graves and payments
  log.ts               structured JSON logging
server/test/           vitest: protocol, rooms, graves, payments, NEAR verification, HTTP + WebSocket integration
client/                Vite app
  src/world/           the graveyard (seeded, identical for every player), grave plots + tombstones, collisions
  src/owl/             owl model (built once, shared) + animation / weird walks
  src/game/            local player, input, camera
  src/net/             connection state machine, remote players + interpolation, grave API client
  src/wallet/          NEAR wallet selector (loaded only when needed)
  src/ui/              HUD, intro, chat, plot card, bury dialog, settings, name tags
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
- Every player gets a random walk style from the server on join; the server ignores any other value.
- Emotes (dance, club, pray, cry, roll) are part of the synced player state.
- Chat is relayed by the server to the room: cleaned (no control/zero-width characters), max 140 chars,
  rate-limited (burst of 3, then one per 1.5 s). There is no chat history or moderation yet.
- Abuse limits: 1 KB max message, token-bucket rate limit (40/s, burst 60), malformed messages counted
  toward disconnect, origin allow-list on the WebSocket, connection cap, ping/pong heartbeat.

## What is verified

- `npm run check`: typecheck clean; 45 tests pass, including real WebSocket sessions for two players
  joining and seeing each other move, resume within the grace period, timeout after it, room capacity
  and overflow, room switching, outdated-client rejection, malformed input, foreign origins, renaming,
  and the health check.
- Manually in two browser sessions against the production build: both players see each other, walking
  animation and walk style sync, server-assigned and changed names propagate, the online count comes from
  the server, refreshing resumes the same player, and auto-reconnect after a server restart.

## Graves and payments

- 40 plots (5 rows x 8, `shared/graves.ts`). Walking up to one highlights the whole plot; **E** opens "Bury a meme".
- The player pastes a NEAR token contract; the server reads name, symbol and logo with `ft_metadata`. Only inline
  `data:` logos are shown (remote image URLs are ignored for safety).
- Tiers: Wooden Cross / Classic Headstone / Grand Tombstone / Mausoleum ($1 / $5 / $10 / $50 tiers). Prices are
  **fixed WTH amounts** from `GRAVE_PRICES_WTH`; update them when the WTH price moves.
- Last words: 1–100 characters. One grave per meme contract, ever. Graves cannot be removed.
- Payment: the server **holds** the plot and the meme for `HOLD_MINUTES` and returns the exact transfer. The player
  sends an `ft_transfer` of WTH to `TREASURY_ACCOUNT` with memo `rip:<paymentId>` from their own wallet. The server
  verifies the NEP-141 `ft_transfer` event on NEAR (token, receiver, sender, memo, amount, final and successful) and
  creates the grave in one database transaction. A transaction hash can only ever be used once.
- A background job (every 15 s) expires unpaid holds and re-checks payments whose verification was interrupted.
- **Refunds are manual.** If a valid payment arrives after its hold expired *and* someone else took the plot or the
  meme meanwhile, the payment is marked `unfulfillable` and logged at error level (`PAID BUT UNFULFILLABLE`) with
  the tx hash, payer and amount. Find them with: `SELECT * FROM payments WHERE status = 'unfulfillable';`
- Data lives in SQLite (`DB_PATH`, default `data/rip.sqlite`). Put it on a persistent disk and back it up.

## Known limits / risks

- Player sessions are in memory: a server restart drops them (clients reconnect as new players). Graves and
  payments are in SQLite and survive restarts.
- The payment verifier is tested against NEAR's documented response format, not yet against a real payment made
  through the game. Make one small real payment ($1 tier) before launch.
- WTH trades on a thin pool; fixed prices avoid manipulation but must be updated by hand.
- One server process. Horizontal scaling would need sticky sessions or a shared room service.
- Movement is client-predicted; the server limits speed and bounds but does not check collisions with
  gravestones, so a modified client can walk through scenery (not through the world edge).
- No accounts yet: names are display names, not identities, and are not unique or moderated beyond a
  character allow-list.
- The JS bundle is ~570 KB (150 KB gzipped), mostly three.js.
