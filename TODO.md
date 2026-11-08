# REST IN PUMP — TODO

Tick a box only when the item works end to end and has been checked in a real browser.
Add your own items anywhere; keep **(you)** on things only you can do or decide.

## Done

- [x] 3D graveyard world and owl mascot (cartoon style, flush open beak, smaller head)
- [x] Each player gets a random weird walk on join (9 styles, server-assigned, cannot be changed)
- [x] Emote bar: Dance, Club, Pray (hands together, bowing), Cry (kneels and cries), Roll (rolls around on the ground) — synced to everyone; keys 1–5
- [x] Snapshot button (P) saves a PNG of the scene
- [x] Music + sound effects, synthesized in the browser (no audio files): sad graveyard theme, weird dance / club tracks while you dance or club, cartoon crying (harder when rolling), hop, offerings, new graves, level-ups, chat, snapshot; mute button + M, Music / Sound effects toggles in Settings
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
- [x] Automated tests (63): protocol, rooms, chat, graves, offerings, minting, NFT artwork + metadata, migration, NEAR verification, HTTP + WebSocket integration, compiled NFT contract
- [x] Project logo (favicon, loading screen, HUD)
- [x] Local git repo, author `wth <whatthehootwth@gmail.com>`

## Graves (built)

- [x] 40 empty plots; the whole plot highlights when you walk up; E / button opens "Create a grave"
- [x] Paste a NEAR token contract → name, symbol and logo read from the chain (ft_metadata)
- [x] One grave price in fixed WTH (config); the tombstone design comes from the memorial level
- [x] Last words 1–100 characters; one grave per contract; graves cannot be removed
- [x] Wallet connect (MyNearWallet, Meteor, HERE, Intear) and WTH balance check
- [x] Payment: hold → ft_transfer to whatthehoot.near with memo → verified on NEAR → grave created (one DB transaction)
- [x] Every payment state: disconnected, connecting, insufficient balance, waiting for approval, sent, confirming,
      done, cancelled in wallet, failed, network error, reservation expired, recovery after refresh / wallet redirect
- [x] Idempotent: one transaction = one grave; background re-check of interrupted verifications
- [x] New graves appear live for everyone; walking up shows logo, name, last words and the creator's wallet
- [ ] **Make one real payment through the game** (a 10,000 WTH offering is cheapest) to confirm verification against a real transaction (you)
- [ ] Decide the refund process for `unfulfillable` payments (manual today) (you)

## Offerings + memorial levels (built)

- [x] Funny offering items (candle, flowers, instant noodles, a rug, diamond hands, copium tank) + any WTH amount ≥ 10,000
- [x] Same verified payment flow (shared with grave creation), every state handled, recovery after refresh / redirect
- [x] Community offering count = successful offerings (not WTH); failed / duplicate / reused never count
- [x] Levels: Forgotten (0–9) → Remembered (10–99) → Honored (100–999) → Legendary (1,000+); tombstone evolves in the world
- [x] Latest offerings shown at the grave; offerings and level-ups announced live in chat
- [x] Burial / bag-burying wording removed (landing, About, plot card, signs, chat)

## Memorial NFTs (built, not deployed)

- [x] NEP-171 contract `contracts/memorial`: one memorial per wallet per grave, "$RUG — Memorial #001", nft_mint event
- [x] Contract tests run against the compiled wasm (`server/test/contract.test.ts`)
- [x] Server minter: queued on first offering, idempotent (memorial_of check), retries with backoff, honest "not switched on" state
- [x] Live metadata JSON with all attributes + artwork that changes with the grave's level, served under /nft
- [x] Plot card + offering dialog show the wallet's memorial status (earned / minting / minted / failed)
- [ ] **Deploy to testnet first, then `memorial.whatthehoot.near`** with the README commands (you)
- [ ] Create `minter.whatthehoot.near` + a function-call key for the server; set `NFT_CONTRACT`, `MINTER_ACCOUNT_ID`, `MINTER_PRIVATE_KEY`, `PUBLIC_BASE_URL` (you)
- [ ] Check a minted memorial shows correctly in MyNearWallet / Meteor and on NearBlocks (you + me)
- [ ] Keep the contract account funded for NFT storage (~0.01 NEAR per memorial) (you)

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
