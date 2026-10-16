# Serialized Stellar Lens

**A public proof of concept of Stellar support in the Serialized Data API.**
Enter any Stellar account (or connect Freighter, xBull or another wallet) and
Lens shows its holdings, reserves, USD values and history, in the same JSON
shapes our production wallet endpoints serve today on 18 EVM chains and
Solana.

This is a **preview**. It reads public Stellar infrastructure (Horizon and
Stellar RPC) from your browser. The production version will run on Serialized's
own Stellar ingestion, and `chain=stellar` is not served by the Serialized API
yet.

![Holdings of the demo account, XLM row verified against the ledger](docs/screenshots/holdings.png)

## What it shows

| Area | What you get | Mirrors |
| --- | --- | --- |
| Header | Live ledger ticker: "Stellar mainnet, ledger #N, closed Xs ago" | |
| Connect | Stellar Wallets Kit modal (all default modules: Freighter, xBull, Albedo, LOBSTR, Rabet, Hana...). Read-only: Lens reads the public key and never asks to sign. Also an address field for `G...` and muxed `M...` addresses, and a demo account. | |
| Holdings | XLM with total, reserved and spendable amounts; every trustline with code, issuer, home domain, SEP-1 verification, flags (authorized, clawback), balance, USD price, value and price source; CAP-38 pool shares split into their two reserves; SEP-41 tokens from a small registry; total portfolio value. | `GET /v1/wallet/positions` |
| Verify | One button per row: reads the account, trustline or pool entry straight from Stellar RPC `getLedgerEntries` and shows "ledger state #N, matches", a newer ledger state, or a mismatch. | |
| Activity | Payments, path payments (one swap row each, with source and destination assets and amounts), account creation and merges, SAC transfers, pool deposits and withdrawals (operations view), memos (text, id, hash), counterparty, time, stellar.expert link, cursor pagination. | `GET /v1/wallet/transfers`, `GET /v1/wallet/swaps` |
| API drawer | The exact JSON our API would return for this account, with copy to clipboard. | the three endpoints above |

URL parameters make every state linkable: `?address=G...&tab=activity&feed=operations&api=1&endpoint=transfers`; `&expand=XLM,EURC` (or `all`) opens holding rows and `&verify=1` runs Verify on them; `?connect=1` opens the wallet picker.

## Screenshots

| | |
| --- | --- |
| ![Home](docs/screenshots/home.png) | ![Activity](docs/screenshots/activity.png) |
| Home | Activity of the demo account |
| ![Path payments](docs/screenshots/activity-path-payments.png) | ![API drawer](docs/screenshots/api-drawer.png) |
| Path payments, one swap row each | API drawer: `/v1/wallet/positions` |
| ![Wallet operator](docs/screenshots/wallet-holdings.png) | ![Wallet picker](docs/screenshots/wallet-modal.png) |
| A wallet operator with 36 trustlines, SEP-1 verified assets and sponsored reserves | Stellar Wallets Kit picker |
| ![Mobile holdings](docs/screenshots/mobile.png) | ![Mobile activity](docs/screenshots/mobile-activity.png) |
| Mobile, 390 px: holdings | Mobile, 390 px: path payments |

Also: [home at 375 px](docs/screenshots/mobile-home.png), [muxed address](docs/screenshots/muxed.png), [operations feed](docs/screenshots/ops.png), [transfers JSON](docs/screenshots/api-transfers.png).

## Demo account

`GAFK7XFZHMLSNV7OJTBO7BAIZA66X6QIBV5RMZZYXK4Q7ZSO52J5C3WQ`, **Circle's USDC and EURC treasury account** on Stellar mainnet.

Why this account:

- **A known organisation, not a person.** It is labelled "Centre" (centre.io, the USDC consortium now part of Circle) in the moderated [stellar.expert directory](https://stellar.expert/explorer/public/directory). It receives USDC mints, as path payments with memo `mint`, from Circle's account `GDEWOLMO...SU32TO5W`, which Circle lists itself in [centre.io/.well-known/stellar.toml](https://centre.io/.well-known/stellar.toml).
- **Several assets:** XLM, USDC, EURC and the legacy EUROC, so the page shows a native row, a face-value stablecoin, an asset priced through SDEX paths with a depth discount, and an asset that stays unpriced with its reason.
- **Very active:** balances move every few minutes, which exercises the "newer ledger state" branch of Verify.

The demo has no CAP-38 pool share: none of the organisations in the stellar.expert directory held one in the XLM/USDC, XLM/AQUA, XLM/EURC, EURC/USDC or AQUA/USDC pools when checked (2026-10-16). The pool share code path is covered by the live test, on a liquidity provider picked at run time from Horizon's pool participants (no address is hard-coded).

The home page also offers a second example: `GC3XQ7GM...ZRH4HWR`, the **DECAF** wallet operator (stellar.expert directory, decaf.so): 36 trustlines, SEP-1 verified assets, clawback-enabled assets, and a large reserve from the accounts it sponsors.

## How it works

Everything runs in the browser (or in node for the tests). No Serialized host is called.

| Source | Used for |
| --- | --- |
| Horizon `https://horizon.stellar.org` | `/accounts/{id}` (balances, flags, subentries, sponsorship counters), `/ledgers` (base reserve), `/liquidity_pools/{id}`, `/accounts/{id}/payments?join=transactions`, `/accounts/{id}/operations?join=transactions`, `/order_book`, `/paths/strict-send`, `/offers` |
| Stellar RPC `https://mainnet.sorobanrpc.com`, fallback `https://soroban-rpc.mainnet.stellar.gateway.fm` | `getHealth` (ledger ticker), `getLedgerEntries` (Verify), `simulateTransaction` (SEP-41 `balance()`, `decimals()`, `symbol()`, `name()`; nothing is ever submitted) |
| `https://{home_domain}/.well-known/stellar.toml` (SEP-1) | Issuer verification: a "verified" tick only when the issuer's stellar.toml lists that exact currency (code and issuer) |
| stellar.expert | Outbound links only |

The ticker uses `getHealth` (sequence and close time in about 200 bytes) rather than `getLatestLedger`, which on protocol 29 also returns the full ledger metadata (about 2.7 MB per call).

### Reserves

`minimum balance = (2 + subentry_count + num_sponsoring - num_sponsored) x base reserve`, with the base reserve read from the latest ledger header (0.5 XLM on mainnet). `reserved = minimum balance + selling liabilities`, `spendable = balance - reserved`. Empty trustlines are listed separately: each still locks a subentry.

### Prices

- **USD unit:** Circle USDC (`USDC:GA5ZSEJY...KZVN`) at face value, 1 USD.
- **XLM/USD:** mid of the SDEX order book XLM/USDC. Guards: both sides present, spread at most 2%, price in a sane window, and agreement within 3% with the classic XLM/USDC pool.
- **Other classic assets:** Horizon strict-send paths toward USDC or XLM (SDEX offers and classic pools). A first probe of 1 unit sizes a second probe of about 10 USD of notional, which gives the unit price. Guards: no path, a 10 USD probe moving the price by more than 50%, or an absurd unit price all leave the asset **unpriced, with the reason shown**. A conversion filled by the USDC issuer's own mint offer (Circle's allowance token) is a mint facility, not a market, and is not used as a price.
- **Value at depth:** as the Serialized API values positions at the depth of their market, a holding worth more than 20 USD is valued at the proceeds of selling the whole balance in one path payment now; the page shows the spot value next to it.
- **Pool shares:** the account's share of each reserve, each at its own price. If one reserve is unpriced, the share is unpriced.
- **SEP-41 tokens:** shown with their balance, unpriced in this preview.

### Verify

The page data comes from Horizon; Verify reads the same entry from Stellar RPC and compares field by field (balance, flags, limit, subentries, liabilities; for a pool share also the pool's total shares and reserves). If the entry was modified in a later ledger than the one shown, the result says so ("changed in ledger #N, after this page loaded") instead of reporting a mismatch. A mismatch is only reported for the same entry version.

### SEP-41 registry

Soroban-native tokens checked with `balance()` by simulation. The Stellar Asset Contracts of the account's own trustlines are not checked: they mirror the trustline balance already read.

| Symbol | Contract | Project | Sources |
| --- | --- | --- | --- |
| CPAL | `CAS3FL6TLZKDGGSISDBWGGPXT3NRR4DYTZD7YOD3HMYO6LTJUVGRVEAM` | Blend (BLND:USDC Comet LP, backstop token) | `blend-capital/blend-utils` mainnet.contracts.json ("comet"); stellar.expert directory |
| SolvBTC | `CBIJBDNZNF4X35BJ4FFZWCDBSCKOP5NB4PLG4SNENRMLAPYG4P5FM6VN` | Solv Protocol | stellar.expert directory (solv.finance); docs.k2lend.com/contracts |
| xSolvBTC | `CAUP7NFABXE5TJRL3FKTPMWRLC7IAXYDCTHQRFSCLR5TMGKHOOQO772J` | Solv Protocol | stellar.expert directory (solv.finance); docs.k2lend.com/contracts |

Each id was also checked on mainnet: a WASM contract whose `symbol()` and `decimals()` match. The live test re-checks the symbols on every run.

### Gentle use of public infrastructure

- In-memory cache per response (ledger 4 s, account 5 to 10 s, payments 15 s, paths 60 s, pools 30 s, issuers 10 min, stellar.toml for the session) and de-duplication of identical in-flight requests.
- At most 4 concurrent Horizon requests, 2 RPC requests and 3 stellar.toml fetches.
- Ledger ticker every 5 s at most, only while the tab is visible, with backoff up to 60 s after failures.
- Bounded retries (2, exponential backoff with jitter) on network errors and 5xx only. A 429 is never retried: that endpoint family is paused until its rate-limit window resets, and the affected rows say "rate limited".
- Activity pages of 50 records with Horizon cursors.
- Per account, at most 40 holdings are priced and 60 trustlines SEP-1 checked. Accounts holding hundreds of airdropped assets show the rest as "not priced" with that reason and a notice, instead of firing hundreds of path-finding requests.

## The JSON shapes

Field names, order and envelope follow the Serialized API reference (docs.serialized.xyz, `openapi.json` and the endpoint pages). Stellar-specific fields live under a `stellar` sub-object on each row; the chain id is `stellar`; asset addresses use the SEP-11 form `CODE:ISSUER` (`native` for XLM), pool shares the pool id, SEP-41 tokens the contract id.

`GET /v1/wallet/positions?chain=stellar&wallet=G...&includeNative=true&includeStables=true&minValueUsd=0&minLiquidityUsd=0` (excerpt):

```json
{
  "data": [
    {
      "key": "stellar:native:native",
      "chain": "stellar",
      "address": "native",
      "symbol": "XLM",
      "name": "Stellar Lumens",
      "iconUrl": null,
      "kind": "native",
      "decimals": 7,
      "amount": "215989.4616093",
      "amountUsd": 39929.9,
      "currentPriceUsd": 0.18487,
      "realizedPnlUsd": 0,
      "buys": 0,
      "labels": [],
      "share": 0.6774,
      "stellar": {
        "assetType": "native",
        "reserves": {
          "total": "215989.4616093",
          "minimumBalance": "3",
          "sellingLiabilities": "0",
          "buyingLiabilities": "0",
          "reserved": "3",
          "spendable": "215986.4616093",
          "baseReserve": "0.5",
          "subentryCount": 4,
          "numSponsoring": 0,
          "numSponsored": 0
        },
        "priceSource": "sdex_orderbook_mid",
        "priceDetail": "SDEX order book XLM/USDC: bid 0.1848, ask 0.1850, mid 0.1849; classic pool XLM/USDC 0.1850 (agrees within 0.06%)",
        "unpricedReason": null,
        "explorerUrl": "https://stellar.expert/explorer/public/account/GAFK7XFZHMLSNV7OJTBO7BAIZA66X6QIBV5RMZZYXK4Q7ZSO52J5C3WQ"
      }
    }
  ],
  "meta": {
    "asOf": 1792151397093,
    "summary": { "totalValueUsd": 5894560, "realizedPnlUsd": null, "unrealizedPnlUsd": null, "totalPnlUsd": null, "positions": 4, "valued": 3 },
    "hasMore": false,
    "stellar": { "account": "GAFK7XFZ...J5C3WQ", "muxedId": null, "ledger": 64973122, "baseReserve": "0.5", "emptyTrustlines": 0, "preview": true }
  }
}
```

Every row carries all 32 fields of the API row in the API's order (the excerpt above drops some for length). Trustline rows add `stellar.code`, `issuer`, `homeDomain`, `verified`, `verification`, `sacContractId` and `trustline` (`authorized`, `authorizedToMaintainLiabilities`, `clawbackEnabled`, `limit`, liabilities, `sponsor`, `lastModifiedLedger`). Pool share rows add `poolId`, `feeBp`, `totalShares`, `sharePercent` and `reserves` (`asset`, `poolAmount`, `amount`, `amountUsd`).

Differences with the API on EVM and Solana, all due to the preview reading public infrastructure:

- Trade-derived fields (`entryPriceUsd`, `exitPriceUsd`, PnL, `boughtTokens`, `buys`, `firstTradeAt`, `holdingSince`, fees) are `null` on `position` rows: they come from a wallet's full trade history, which our own ingestion will provide. Native and stable rows carry the zeros the API serves for them.
- `marketCapUsd` and `iconUrl` are `null`.
- A path payment between two different accounts is a transfer carrying `stellar.conversion`; `/v1/wallet/swaps` lists the account's own path payments (source and destination both the account), one row per transaction, with `route: null` (per-hop venues need trade effects).
- `amountUsd` on transfers is only filled for Circle USDC (face value): historical prices come with our own ingestion.

`GET /v1/wallet/transfers?chain=stellar&wallet=G...&limit=50` (one row):

```json
{
  "data": [
    {
      "at": 1792141387000,
      "chain": "stellar",
      "txHash": "7b5c80ac4bad7543805df5f8c31af8473fd565ea781eab5b7e1b867a167bfe02",
      "direction": "out",
      "tokenAddress": "USDCAllow:GDIEKKIQWMIZ4LD3RP3ABPN7X5KEAEWYMR634BRHB7EULIMEVREWLF3G",
      "tokenSymbol": "USDCAllow",
      "amount": "620000",
      "amountUsd": null,
      "counterparty": "GAFK7XFZHMLSNV7OJTBO7BAIZA66X6QIBV5RMZZYXK4Q7ZSO52J5C3WQ",
      "stellar": {
        "operationId": "279048839879671809",
        "operationType": "path_payment_strict_receive",
        "memo": { "type": "text", "value": "mint" },
        "muxedId": null,
        "ledger": 64971121,
        "conversion": {
          "sourceAsset": "USDCAllow:GDIEKKIQWMIZ4LD3RP3ABPN7X5KEAEWYMR634BRHB7EULIMEVREWLF3G",
          "sourceAmount": "620000",
          "destinationAsset": "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
          "destinationAmount": "620000",
          "path": []
        },
        "explorerUrl": "https://stellar.expert/explorer/public/op/279048839879671809"
      }
    }
  ],
  "meta": { "asOf": 1792151237460, "hasMore": true, "nextCursor": "278947929623515137", "oldestAt": 1792141387000 }
}
```

## Run it

Requirements: Node 24 and pnpm 10.

```bash
pnpm install          # exact versions from pnpm-lock.yaml
pnpm dev              # http://localhost:5173
pnpm build            # tsc --noEmit, then vite build into dist/
pnpm preview          # serve dist/ on http://localhost:4173
pnpm test             # node tests/live.test.ts, against Stellar mainnet
```

`dist/` uses relative asset paths (`base: "./"`), so it can be served from any path, GitHub Pages included.

### Live test

`tests/live.test.ts` runs with node's built-in type stripping (no test runner). Against mainnet, for the demo account, Circle's mint account and the DECAF account, it checks that (a) the positions JSON matches the API schema (field list and order copied from the API reference, types, keys, shares summing to 100%), (b) every trustline balance and the XLM balance equal `getLedgerEntries` (re-reading when an entry changed between the two reads), (c) the reserves math holds against the ledger entry, and (d) every path payment renders as exactly one swap row with the right assets and amounts. It also checks the muxed address parsing, the XLM price guards, the Verify logic, the SEP-41 registry symbols, and a CAP-38 pool share split and verified on a liquidity provider picked at run time.

## Limits of this preview

- **SEP-41 tokens** are only found when they are in the registry above. Our own ingestion indexes every token contract.
- **Prices** come from Horizon path finding over SDEX and classic pools at the moment of the request. Soroban AMMs (Aquarius, Soroswap, Phoenix...) are not priced here, so assets traded only there show as unpriced. Single-path depth undervalues balances that a split execution could sell better.
- **History depth** is whatever Horizon serves; there is no historical USD valuation of past transfers.
- **Account merges** show the destination but not the merged amount (it is in the operation effects, not in the payments record).
- **Holdings** are read once per load (no streaming). The production API streams at ledger close.
- **Rate limits:** the public Horizon instance limits path-finding requests per IP. When the limit is hit, the affected rows say so and pricing resumes after the window.

## Roadmap

The production version replaces every public read with Serialized's own Stellar ingestion: complete holdings from ledger state (trustlines, SAC and every SEP-41 balance, CAP-38 shares), one history across classic operations and Soroban events, USD prices for every asset from SDEX, classic pools and Soroban AMM trades, candles, and streams at ledger close, served on the same `/v1/wallet/*` endpoints with `chain=stellar`. See [serialized.xyz](https://serialized.xyz) and [docs.serialized.xyz](https://docs.serialized.xyz).

## Tech notes

- Vite 8, React 19, TypeScript 5.9 (strict), plain CSS, `@stellar/stellar-sdk` 17.2.1, `@creit.tech/stellar-wallets-kit` 2.7.0. All versions are exact; `pnpm-workspace.yaml` sets `minimumReleaseAge: 20160` (14 days) for direct and transitive dependencies, and package build scripts are not run.
- The data layer (`src/data/`) is plain TypeScript with no UI dependency, runnable in the browser and in node.
- React types: `@types/react` is not installed; `src/types/react-shim.d.ts` declares the subset of React used here. Deleting it after adding `@types/react` is enough.
- The wallet kit is loaded on first use, in its own chunks.

## License

None yet.
