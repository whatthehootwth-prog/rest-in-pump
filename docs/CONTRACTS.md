# Contracts and On-chain Accounts

REST IN PUMP deploys one smart contract, the Memorial NFT contract. Payments and buybacks use ordinary NEAR accounts and existing token and DEX contracts. This page lists what is on chain, what each piece enforces, and what is handled by the game server instead.

## Accounts

All checked on NEAR mainnet on 14 Nov 2026.

| Account | Role | Keys |
|---|---|---|
| [`memorial.whatthehootbrain.near`](https://nearblocks.io/address/memorial.whatthehootbrain.near) | Memorial NFT contract | One full-access key (the owner's) |
| `minter.whatthehootbrain.near` | Mints memorials | Owner's full-access key; the server's key is a function-call key limited to `mint_memorial` on the memorial contract |
| [`buyback.whatthehootbrain.near`](https://nearblocks.io/address/buyback.whatthehootbrain.near) | Treasury: receives payments, runs buyback rounds | Two full-access keys (owner and server) |
| `whatthehootbrain.near` | Owner of the three accounts above and of the NFT contract settings | Team |
| `whatthehoot.near` | Team wallet: receives the 20% team share | Team |

Existing contracts used, not deployed by this project:

| Contract | Used for |
|---|---|
| `wrap.near` | Wrapping NEAR into wNEAR (NEP-141) |
| `dclv2.ref-labs.near` | RHEA DCL: quote and swap on the WTH/NEAR pool |
| `wth-0b2227.launchpad.justhoot.near` | WTH token (NEP-141): balances and payouts |

## Memorial NFT contract

Source: [`contracts/memorial/src/lib.rs`](../contracts/memorial/src/lib.rs). Rust, near-sdk 5.29, built from `near-contract-standards`.

| Property | Value |
|---|---|
| Standards | NEP-171 core, NEP-177 metadata, NEP-178 approvals, NEP-181 enumeration; standard `nft_mint` events |
| Name / symbol | Rest In Pump Memorials / RIPM |
| `base_uri` | `https://rip.whatthehoot.lol/nft` |
| Owner (`get_owner`) | `whatthehootbrain.near` |
| Minter (`get_minter`) | `minter.whatthehootbrain.near` |
| Total supply on 14 Nov 2026 | 3 (`1-1` $NEKO, `2-1` $BABYBLACKDRAGON, `3-1` $LONK, all owned by `whatthehootest.near`) |

### Minting and ownership

- `mint_memorial(grave_id, receiver_id, name_prefix, description)` can only be called by the minter account.
- **One memorial per wallet per grave**, enforced by the contract: it keeps a `"<grave_id>:<account>"` map and refuses a second mint for the same pair, even if the first token was transferred away.
- Token ids are `<grave_id>-<serial>`; the title is `"$TICKER Memorial #001"`, numbered per grave.
- Storage is paid from the contract's own balance; minting needs no deposit.
- Tokens are standard NEP-171: owners can transfer them and approve marketplaces. There is no burning, staking, yield or payment logic.

### Authorization rules

| Method | Who can call |
|---|---|
| `mint_memorial` | Minter account only |
| `set_minter`, `set_base_uri` | Owner only |
| `nft_transfer`, `nft_approve` and other NEP-171/178 calls | Token owners, as the standards define |
| Views (`nft_token`, `nft_tokens`, `nft_tokens_for_owner`, `memorial_of`, `memorial_count`, `get_owner`, `get_minter`, `nft_metadata`) | Anyone |

The memorial account also holds a full-access key, so its owner can redeploy the contract code. That is an upgrade path and a trust assumption.

### Dynamic artwork and metadata

Each token stores relative links: `media = grave/<id>/media.svg`, `reference = token/<token_id>.json`. Wallets resolve them against `base_uri`, and the game server renders them from its current data:

- the artwork shows the grave's current level design with the memecoin's logo, ticker and EXP;
- the JSON lists the memecoin name and contract, chain, grave id, level, community EXP, offering counts, the original participant wallet, personal offerings and dates.

Example: [`/nft/token/1-1.json`](https://rip.whatthehoot.lol/nft/token/1-1.json).

**Limitation:** the artwork and attributes are served by the game, not stored on chain. If the server is down, wallets cannot load them, although ownership, titles and transfer history stay on chain. The owner can move the host with `set_base_uri`.

## What is on chain and what is not

| On chain | In the game server (SQLite) |
|---|---|
| Player payments (NEAR transfers to the treasury) | Orders, prices, holds, verification results |
| Memorial NFT ownership, transfers, approvals | Community EXP, grave levels, offering counts |
| One-memorial-per-wallet-per-grave rule | Which wallets are owed a memorial (the queue) |
| NFT titles and token links | NFT artwork and attributes (served live) |
| Team transfers, swaps and WTH payouts of a buyback round | When a round runs, the 80/20 split, holder selection |

The NFT contract does not know about offerings, EXP, levels or the treasury. The server decides who receives a memorial and when a buyback runs; the chain records and enforces ownership and the transactions themselves.

## Verifiable evidence

- Contract and tokens: https://nearblocks.io/address/memorial.whatthehootbrain.near
- Grave payments to the treasury:
  - https://nearblocks.io/txns/EDphamgQgat9AxcqZN5jq93X22ACmpQeZMZjMV53SxHw
  - https://nearblocks.io/txns/4Fi5Jd5YjEHgNs3n7EHmR7Tevp4V1tZRQu8UQy12KcCz
- Treasury account creation: https://nearblocks.io/txns/CYPMkrVTt9TwWJRAM8wP76cid8XB86nxT2chP2LZdyFc
- Buyback history (no rounds yet on 14 Nov 2026): https://rip.whatthehoot.lol/api/buybacks

Reading the contract directly (NEAR CLI):

```bash
near contract call-function as-read-only memorial.whatthehootbrain.near nft_total_supply json-args {} network-config mainnet now
near contract call-function as-read-only memorial.whatthehootbrain.near nft_tokens json-args '{"from_index":"0","limit":10}' network-config mainnet now
near contract call-function as-read-only memorial.whatthehootbrain.near get_minter json-args {} network-config mainnet now
```

## Building and testing the contract

```bash
npm run contract:build    # needs Rust and the wasm32-unknown-unknown target
npm test                  # includes server/test/contract.test.ts, which runs the compiled wasm against a mocked NEAR host
```

The build uses `--cfg near` (set in `contracts/memorial/.cargo/config.toml`). `scripts/deploy-memorial.ts` creates the memorial and minter accounts, deploys and initialises the contract, and gives the minter a mint-only key (it has `--dry-run`).
