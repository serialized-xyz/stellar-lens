// Static configuration of the preview: public endpoints, well-known assets,
// the demo account and the SEP-41 token registry. Every value here is public
// and documented in README.md.

export const NETWORK_PASSPHRASE = 'Public Global Stellar Network ; September 2015';

/** Public Horizon instance run by the Stellar Development Foundation (CORS enabled). */
export const HORIZON_URL = 'https://horizon.stellar.org';

/** Public Stellar RPC endpoints, tried in order (CORS enabled, protocol 29). */
export const RPC_URLS: readonly string[] = [
  'https://mainnet.sorobanrpc.com',
  'https://soroban-rpc.mainnet.stellar.gateway.fm',
];

/** Outbound links only: the preview never calls this host. */
export const EXPLORER_URL = 'https://stellar.expert/explorer/public';

/** Public chain id, as on every other chain of the Serialized Data API. */
export const CHAIN_ID = 'stellar';

/** Circle USDC on Stellar. The only asset this preview values at face value (1 USD). */
export const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
export const USDC_ID = `USDC:${USDC_ISSUER}`;

/** Stellar amounts carry 7 decimals (1 XLM = 10,000,000 stroops). */
export const STELLAR_DECIMALS = 7;

/**
 * Demo account: a USDC account of Centre (centre.io, the USDC consortium now
 * part of Circle) on Stellar mainnet. The moderated stellar.expert directory
 * labels it "Centre" (tag: anchor); centre.io's stellar.toml does not list it
 * (it lists the USDC issuer and GDEWOLMO...). It holds XLM, USDC, EURC and
 * legacy EUROC, receives USDC mints as path payments with memo "mint" from
 * GDEWOLMO..., and its activity looks operational (payouts, deposits with
 * memos, a 1 USDC self-payment every few minutes).
 */
export const DEMO_ACCOUNT = {
  address: 'GAFK7XFZHMLSNV7OJTBO7BAIZA66X6QIBV5RMZZYXK4Q7ZSO52J5C3WQ',
  label: 'Centre (Circle) USDC account',
  source: 'stellar.expert directory label "Centre" (centre.io, tag: anchor)',
} as const;

/** Other organisations' accounts offered as examples (labels from the moderated stellar.expert directory). */
export const EXAMPLE_ACCOUNTS: ReadonlyArray<{ address: string; label: string; why: string; source: string }> = [
  {
    address: 'GC3XQ7GM6XO36MORCS2SRHHEC2G52FMO4FHPLKUG76EKMTF73ZRH4HWR',
    label: 'Decaf',
    why: '36 trustlines, verified assets, clawback flags, and the reserves of every account it sponsors',
    source: 'stellar.expert directory label "Decaf" (decaf.so, tag: custodian)',
  },
];

export interface Sep41RegistryEntry {
  contractId: string;
  symbol: string;
  name: string;
  project: string;
  /** Where the contract id was cross-checked. */
  sources: readonly string[];
}

/**
 * SEP-41 tokens checked by `balance()` simulation. Soroban-native tokens only:
 * the Stellar Asset Contract of a classic asset mirrors its trustline, which
 * the holdings already read. Each id was cross-checked against the sources
 * listed and against the contract's own symbol(), name() and decimals() on
 * mainnet (2026-10-16).
 */
export const SEP41_REGISTRY: readonly Sep41RegistryEntry[] = [
  {
    contractId: 'CAS3FL6TLZKDGGSISDBWGGPXT3NRR4DYTZD7YOD3HMYO6LTJUVGRVEAM',
    symbol: 'CPAL',
    name: 'Comet Pool Token (BLND:USDC, Blend backstop)',
    project: 'Blend',
    sources: [
      'github.com/blend-capital/blend-utils mainnet.contracts.json ("comet")',
      'stellar.expert directory ("CometDEX Pool")',
    ],
  },
  {
    contractId: 'CBIJBDNZNF4X35BJ4FFZWCDBSCKOP5NB4PLG4SNENRMLAPYG4P5FM6VN',
    symbol: 'SolvBTC',
    name: 'Solv BTC',
    project: 'Solv Protocol',
    sources: ['stellar.expert directory ("SolvBTC", solv.finance)', 'docs.k2lend.com/contracts'],
  },
  {
    contractId: 'CAUP7NFABXE5TJRL3FKTPMWRLC7IAXYDCTHQRFSCLR5TMGKHOOQO772J',
    symbol: 'xSolvBTC',
    name: 'xSolvBTC',
    project: 'Solv Protocol',
    sources: ['stellar.expert directory ("xSolvBTC", solv.finance)', 'docs.k2lend.com/contracts'],
  },
];

/** Gentle-use limits for public infrastructure. */
export const LIMITS = {
  /** Ledger ticker poll interval. */
  tickerMs: 5_000,
  /** Concurrent requests per host. */
  horizonConcurrency: 4,
  rpcConcurrency: 2,
  tomlConcurrency: 3,
  /** Page size of the activity feeds. */
  activityPage: 50,
  /** Retries after the first attempt, with exponential backoff. */
  retries: 2,
  requestTimeoutMs: 12_000,
  /**
   * Per account, at most this many holdings are priced (1 to 3 path-finding
   * requests each) and this many trustlines are SEP-1 checked. Spam-heavy
   * accounts hold hundreds of trustlines: the rest is shown unpriced, with
   * the reason, instead of firing hundreds of requests at public Horizon.
   */
  maxPricedHoldings: 40,
  maxVerifiedTrustlines: 60,
} as const;

export const explorer = {
  account: (id: string) => `${EXPLORER_URL}/account/${id}`,
  tx: (hash: string) => `${EXPLORER_URL}/tx/${hash}`,
  op: (id: string) => `${EXPLORER_URL}/op/${id}`,
  asset: (code: string, issuer: string) => `${EXPLORER_URL}/asset/${code}-${issuer}`,
  pool: (id: string) => `${EXPLORER_URL}/liquidity-pool/${id}`,
  contract: (id: string) => `${EXPLORER_URL}/contract/${id}`,
  ledger: (seq: number) => `${EXPLORER_URL}/ledger/${seq}`,
};
