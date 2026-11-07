# REST IN PUMP — TODO

Tick a box only when the item works end to end and has been checked in a real browser.
Add your own items anywhere; keep **(you)** on things only you can do or decide.

## Done

- [x] 3D graveyard world and owl mascot (cartoon style, flush open beak, smaller head)
- [x] Each player gets a random weird walk on join (9 styles, server-assigned, cannot be changed)
- [x] Emote bar: Dance, Club, Pray (拜拜), Cry (kneels and cries, 跪下哭), Roll (滚来滚去) — synced to everyone; keys 1–5
- [x] Snapshot button (P) saves a PNG of the scene
- [x] Chat (bottom left): server-relayed, validated, rate-limited, speech bubbles above heads
- [x] Fixed low render resolution (no resolution setting)
- [x] Intro scene: pitch, Enter the Meme Graveyard, What is Rest In Pump? explainer, real player count; joining happens only on Enter
- [x] Project structure: Vite client, Node game server, shared validated protocol
- [x] Multiplayer: real players see each other, synced movement, walk style and animation
- [x] One shared graveyard for everyone (capacity 50 by default, `ROOM_CAPACITY`)
- [x] Disconnect handling, 20 s resume window, refresh resumes the same player
- [x] Reconnect with backoff and clear status banner (reconnecting / offline / full / outdated)
- [x] Server checks: speed/teleport limits, world bounds, rate limits, origin allow-list, heartbeats
- [x] Minimal HUD: real online count, name change, shadows toggle (no top-left panel)
- [x] Automated tests (45): protocol, rooms, chat, graves, payments, NEAR verification, HTTP + WebSocket integration
- [x] Project logo (favicon, loading screen, HUD)
- [x] Local git repo, author `wth <whatthehootwth@gmail.com>`

## Graves (built)

- [x] 40 empty plots; the whole plot highlights when you walk up; E / button opens "Bury a meme"
- [x] Paste a NEAR token contract → name, symbol and logo read from the chain (ft_metadata)
- [x] 4 tombstone tiers ($1 / $5 / $10 / $50) with different designs, priced in fixed WTH amounts (config)
- [x] Last words 1–100 characters; one grave per contract; graves cannot be removed
- [x] Wallet connect (MyNearWallet, Meteor, HERE, Intear) and WTH balance check
- [x] Payment: hold → ft_transfer to whatthehoot.near with memo → verified on NEAR → grave created (one DB transaction)
- [x] Every payment state: disconnected, connecting, insufficient balance, waiting for approval, sent, confirming,
      done, cancelled in wallet, failed, network error, reservation expired, recovery after refresh / wallet redirect
- [x] Idempotent: one transaction = one grave; background re-check of interrupted verifications
- [x] New graves appear live for everyone; walking up shows logo, name, last words and the creator's wallet
- [ ] **Make one real $1-tier payment through the game** to confirm verification against a real transaction (you)
- [ ] Decide the refund process for `unfulfillable` payments (manual today) (you)

## Next — Offerings

- [ ] Funny offering items (e.g. candle, flowers, instant noodles, rug, diamond hands, copium tank)
- [ ] Any WTH amount above a minimum, using the same verified payment flow
- [ ] Offerings appear at the grave for everyone; the grave shows total WTH offered and recent offerings

## Later

- [ ] Grave search (by name / ticker / contract)
- [ ] Memes on other chains (Solana, Base, Ethereum): name + logo lookup for each chain
- [ ] More plots: expand the map or open more graveyards when these 40 fill up
- [ ] Moderation for grave messages (report / hide)

## Launch checklist

- [ ] Create GitHub repo and push (you)
- [ ] Hosting + domain + HTTPS (wss://) (you)
- [ ] Set production env: `ALLOWED_ORIGINS`, `NODE_ENV=production`, room limits
- [ ] Uptime monitoring on `/healthz`, log collection, error alerts
- [ ] Database backups
- [ ] Load test: how many players the one graveyard handles smoothly
- [ ] Test on phones (touch controls) and low-end laptops
- [ ] Terms of service + privacy policy, crypto/legal check for your region (you)
- [ ] Profanity filter / reporting / mute for names and chat before public launch

## Your items

- [ ]
