# REST IN PUMP

A multiplayer cartoon graveyard. Players walk around as the owl mascot and see each other in real time.

## Status

| Area | State |
|---|---|
| 3D world + owl character | Done (ported from the prototype, unchanged look) |
| Multiplayer (rooms, sync, reconnect) | **Done — phase 1** (see "What is verified") |
| Wallet / NEAR / $WTH payments | Not started — needs decisions + configuration |
| Graves, funerals, offerings, search (database) | Not started |
| Market data / resurrection rules | Not started |

The HUD only shows controls that work. Wallet, Bury a Meme and Grave search buttons will appear when those
features exist end to end.

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
server/src/            game server (Node + ws)
  config.ts            env configuration (see .env.example)
  rooms.ts             room / player bookkeeping, pure logic (unit-tested)
  server.ts            HTTP (static files, /healthz) + WebSocket handling, rate limits, heartbeats
  log.ts               structured JSON logging
server/test/           vitest: protocol, rooms, and real two-client WebSocket integration tests
client/                Vite app
  src/world/           the graveyard (seeded, identical for every player) + collisions
  src/owl/             owl model (built once, shared) + animation / weird walks
  src/game/            local player, input, camera
  src/net/             connection state machine, remote players + interpolation
  src/ui/              HUD, settings dialog, name tags
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

- `npm run check`: typecheck clean; 25 tests pass, including real WebSocket sessions for two players
  joining and seeing each other move, resume within the grace period, timeout after it, room capacity
  and overflow, room switching, outdated-client rejection, malformed input, foreign origins, renaming,
  and the health check.
- Manually in two browser sessions against the production build: both players see each other, walking
  animation and walk style sync, server-assigned and changed names propagate, the online count comes from
  the server, refreshing resumes the same player, and auto-reconnect after a server restart.

## Known limits / risks

- State is in memory: a server restart drops all sessions (clients reconnect as new players). Fine for
  presence; persistent features (graves, purchases) will need the database.
- One server process. Horizontal scaling would need sticky sessions or a shared room service.
- Movement is client-predicted; the server limits speed and bounds but does not check collisions with
  gravestones, so a modified client can walk through scenery (not through the world edge).
- No accounts yet: names are display names, not identities, and are not unique or moderated beyond a
  character allow-list.
- The JS bundle is ~570 KB (150 KB gzipped), mostly three.js.
