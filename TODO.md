# REST IN PUMP — TODO

Tick a box only when the item works end to end and has been checked in a real browser.
Add your own items anywhere; keep **(you)** on things only you can do or decide.

## Done

- [x] 3D graveyard world and owl mascot (cartoon style, flush open beak, 10 weird walks)
- [x] Project structure: Vite client, Node game server, shared validated protocol
- [x] Multiplayer: real players see each other, synced movement, walk style and animation
- [x] Rooms with capacity limits, auto-open next room, switch room in Settings
- [x] Disconnect handling, 20 s resume window, refresh resumes the same player
- [x] Reconnect with backoff and clear status banner (reconnecting / offline / full / outdated)
- [x] Server checks: speed/teleport limits, world bounds, rate limits, origin allow-list, heartbeats
- [x] Minimal HUD: real online count, name change, room list, graphics settings
- [x] Automated tests (21): protocol, rooms, two-client WebSocket integration
- [x] Project logo (favicon, loading screen, HUD)
- [x] Local git repo, author `wth <whatthehootwth@gmail.com>`

## Decisions needed before the next features (you)

- [ ] **$WTH token**: NEAR contract account, mainnet or testnet, NEP-141?, decimals
- [ ] **Treasury account** that receives WTH payments
- [ ] **"Bury a Meme"**: what exactly is buried (a token? which chain?) and what a grave shows
- [ ] **Market data source** for memes (which API / DEX), and how often to refresh
- [ ] **Prices** in WTH: funeral, each offering type, any free actions
- [ ] **Resurrection rule**: the exact market condition that resurrects a grave
- [ ] **Grave placement rules**: where graves can go, how many per player, can they be moved/removed
- [ ] **Hosting**: where the server and the database run, and the domain name

## Phase 2 — Graves + database (no money yet)

- [ ] Choose and set up Postgres (local + hosted), migrations
- [ ] Grave model: id, owner, meme, epitaph, position, created time, status
- [ ] Place a grave in the world (valid plots only, no overlaps), saved in the database
- [ ] Graves load from the database for every player; new graves appear live for everyone
- [ ] Click a grave → grave info panel
- [ ] Grave search (by name / meme) with loading, empty and error states
- [ ] Moderation basics: epitaph length + content limits, report/hide
- [ ] Tests: API, persistence across restart, two players see the same new grave
- [ ] Add "Bury a Meme" and "Grave search" to the HUD only once they work

## Phase 3 — NEAR wallet sign-in

- [ ] NEAR wallet selector in the client
- [ ] Server verifies a signed message → session tied to the NEAR account
- [ ] Players can keep their name across devices
- [ ] Wallet button in the HUD with every state (disconnected, connecting, connected, wrong network, error)

## Phase 4 — $WTH payments (verified on NEAR)

- [ ] Purchase flow with all states: initial, wallet disconnected, connecting, insufficient balance,
      waiting for approval, submitted, confirming, paid, fulfilled, rejected, failed, network error,
      recovery after refresh
- [ ] Server verifies the transfer on-chain (amount, token contract, receiver, sender) before fulfilling
- [ ] Idempotency: one transaction hash = one purchase, retries can never duplicate
- [ ] Background job re-checks pending payments after restarts
- [ ] Other players see the result (funeral / offering) live
- [ ] Tests on testnet before mainnet

## Phase 5 — Market data + resurrection

- [ ] Market data service with caching, rate-limit handling and "data unavailable" states
- [ ] Resurrection monitor following the agreed rule, with logs
- [ ] Resurrection event shown in-world for everyone, tied to the real rule

## Launch checklist

- [ ] Create GitHub repo and push (you)
- [ ] Hosting + domain + HTTPS (wss://) (you)
- [ ] Set production env: `ALLOWED_ORIGINS`, `NODE_ENV=production`, room limits
- [ ] Uptime monitoring on `/healthz`, log collection, error alerts
- [ ] Database backups
- [ ] Load test: many players in one room, many rooms
- [ ] Test on phones (touch controls) and low-end laptops
- [ ] Terms of service + privacy policy, crypto/legal check for your region (you)
- [ ] Profanity filter / reporting for names before public launch

## Your items

- [ ]
