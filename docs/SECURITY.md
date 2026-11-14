# Security

An honest overview of the safeguards in REST IN PUMP and the risks that remain. The project has had an internal review (fixes S01 to S08 in commit `e066786`) but **no formal external audit**.

## Trust model in one paragraph

Players sign every payment in their own wallet; the game never holds their keys. After that, the game server is trusted: it verifies payments, keeps community EXP and levels, decides who receives a Memorial NFT, and runs buyback rounds with a full-access key to the treasury. The NFT contract independently enforces minter-only minting and one memorial per wallet per grave, and the chain records every payment, mint, swap and payout publicly.

## Wallets and account permissions

| Account | Key on the server | Can do |
|---|---|---|
| Player wallets | None | Players sign each transfer themselves through NEAR Wallet Selector |
| `minter.whatthehootbrain.near` | Function-call key limited to `mint_memorial` on the memorial contract, with a 0.25 NEAR gas allowance | Mint memorials only; cannot move NEAR or change the contract |
| `buyback.whatthehootbrain.near` | Full-access key | Send NEAR and tokens (needed for the team share, swap and payouts) |
| `memorial.whatthehootbrain.near` | None | Its owner key is kept off the server |

Keys are read only from environment variables (`MINTER_PRIVATE_KEY`, `BUYBACK_PRIVATE_KEY`) set in Railway; they are not in the repository. The setup scripts (`scripts/deploy-memorial.ts`, `scripts/create-buyback.ts`) read the owner's key from hidden terminal input and never store it. Only revenue and a small reserve should be kept in the treasury.

## Payment validation

- The server, not the browser, sets every price.
- Each order has a unique exact amount (price plus a random tail below 0.000001 NEAR).
- A payment counts only if the transaction is final and successful, signed by the connected account, sent to the treasury, for exactly the order's amount, and made after the order was created.
- The browser cannot mark an order paid; it can only submit a transaction hash for the server to check.

## Duplicate transaction protection

- A transaction hash is unique in the database: it can fulfil at most one order, once.
- One payment creates at most one grave or one offering (unique keys).
- Memorial NFTs are unique per (grave, wallet) in the database, and the contract refuses a second mint for the same pair. The minter also checks `memorial_of` before minting, so retries never double-mint.

## Order expiry and recovery

- Grave orders hold the plot and memecoin for `HOLD_MINUTES`; unpaid holds expire.
- Limits: 2 open grave holds per IP, 3 open offerings per browser session and 10 per IP; at most 8 verifications run straight from confirm requests (the rest go to the background sweep).
- Orders belong to the browser that created them (`x-rip-session`), not to a shared IP.
- The browser saves the sent transaction hash immediately and reuses it after a reload, lost confirmation or double click, so players are not asked to pay twice.
- A hash NEAR never sees releases its plot 10 minutes after the hold ends, but is still re-checked.

## API and multiplayer limits

- Token-bucket rate limits per IP on the API (40 per minute, burst 20; coin search 60 per minute) and on the coin preview.
- WebSocket: origin allow-list, connection cap, 1 KB message limit, per-connection rate limit, heartbeats; malformed messages count toward a disconnect.
- The server clamps every movement update (world bounds, speed, hop height, valid walk and emote). Movement is client-predicted, so a modified client could walk through gravestones, but not out of the world.
- Chat is cleaned (no control or invisible characters), limited to 140 characters, and rate-limited (burst of 3, then one per 1.5 seconds).
- Security headers on every response, including a Content-Security-Policy and `cross-origin-opener-policy: same-origin-allow-popups` for wallet popups.

## External logos and metadata

Token logos come from token creators, so they are treated as untrusted:

- downloaded only over https on port 443, never from IP literals or local names;
- every resolved address checked against private and reserved ranges (including IPv4 hidden in IPv6), every redirect re-checked, and the DNS answer pinned for the connection;
- size-capped while streaming, decoded only if the bytes are PNG, JPEG, GIF, WebP or SVG, with risky decoders blocked and limited parallel jobs;
- re-encoded as small WebP data URIs, so browsers never load third-party images.

NFT artwork escapes memecoin names and refuses unsafe logo data (tested).

## Buyback safeguards

- Every step is written to the database before its transaction is sent.
- Definite failures before sending are retried at the next check.
- Unknown outcomes (timeouts, lost connections, a restart mid-send) stop the round as `needs_check`, and no new round starts until an operator has checked the chain.
- The swap has a 2% minimum-output limit enforced by the DEX contract.
- The round refuses to pay if the holder list may be incomplete above the minimum holding.
- All rounds and payouts are public at `/api/buybacks`.

## Remaining risks and limitations

| Area | Status |
|---|---|
| **Administrative trust** | The operator controls the server, the treasury key and the NFT contract's owner key (which can change the minter and the media host, and can redeploy the contract). Players trust them to run the published rules. |
| **Dependency vulnerabilities** | `npm audit --omit=dev` (14 Nov 2026) reports 9 high, 2 moderate, 14 low. The high entries are inside the Meteor and HERE wallet SDKs and their libraries (`@meteorwallet/sdk`, `@here-wallet/core`, `bs58`, `base-x`, `nanoid`, `query-string`, `decode-uri-component`, `@near-js/utils`). npm only offers a major downgrade, so nothing has been changed. Intear wallet was removed because of a message-origin issue in its adapter. |
| **Database backups** | SQLite lives on one Railway volume. Volume backups must be switched on; a lost volume would lose graves, EXP and payment records (on-chain payments and NFTs would remain). |
| **Refunds** | Manual. Payments that arrive after their plot or memecoin was taken are logged as `unfulfillable` for the operator. |
| **Chat moderation** | None beyond cleaning and rate limits: no word filter, reports or mute. |
| **NFT media hosting** | Artwork and attributes are served by the game server; ownership is unaffected if it is down. |
| **Price feeds** | A wrong public NEAR/USD feed would mis-price orders within the accepted range ($0.01 to $10,000). |
| **Sessions** | Player sessions are in memory; a restart reconnects everyone as new players. |
| **Legal** | Revenue sharing with token holders may have legal consequences in some jurisdictions. |
