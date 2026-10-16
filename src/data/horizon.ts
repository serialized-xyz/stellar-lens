// Typed, cached reads from the public Horizon API.

import { HORIZON_URL, LIMITS } from './config.ts';
import { limiter, requestJson } from './http.ts';

const horizonLimit = limiter(LIMITS.horizonConcurrency);

export interface HorizonBalanceNative {
  asset_type: 'native';
  balance: string;
  buying_liabilities: string;
  selling_liabilities: string;
}

export interface HorizonBalanceCredit {
  asset_type: 'credit_alphanum4' | 'credit_alphanum12';
  asset_code: string;
  asset_issuer: string;
  balance: string;
  limit: string;
  buying_liabilities: string;
  selling_liabilities: string;
  last_modified_ledger: number;
  is_authorized: boolean;
  is_authorized_to_maintain_liabilities: boolean;
  is_clawback_enabled?: boolean;
  sponsor?: string;
}

export interface HorizonBalancePool {
  asset_type: 'liquidity_pool_shares';
  liquidity_pool_id: string;
  balance: string;
  limit: string;
  last_modified_ledger: number;
  is_authorized?: boolean;
  is_authorized_to_maintain_liabilities?: boolean;
  is_clawback_enabled?: boolean;
  sponsor?: string;
}

export type HorizonBalance = HorizonBalanceNative | HorizonBalanceCredit | HorizonBalancePool;

export interface HorizonFlags {
  auth_required: boolean;
  auth_revocable: boolean;
  auth_immutable: boolean;
  auth_clawback_enabled: boolean;
}

export interface HorizonAccount {
  id: string;
  account_id: string;
  sequence: string;
  subentry_count: number;
  num_sponsoring: number;
  num_sponsored: number;
  home_domain?: string;
  last_modified_ledger: number;
  last_modified_time: string;
  flags: HorizonFlags;
  balances: HorizonBalance[];
  sponsor?: string;
}

export interface HorizonLedger {
  sequence: number;
  hash: string;
  closed_at: string;
  base_fee_in_stroops: number;
  base_reserve_in_stroops: number;
  successful_transaction_count: number;
  operation_count: number;
  protocol_version: number;
}

export interface HorizonReserve {
  asset: string;
  amount: string;
}

export interface HorizonLiquidityPool {
  id: string;
  fee_bp: number;
  type: 'constant_product';
  total_trustlines: string;
  total_shares: string;
  reserves: HorizonReserve[];
  last_modified_ledger: number;
}

export interface HorizonTransaction {
  hash: string;
  ledger: number;
  created_at: string;
  memo_type: 'none' | 'text' | 'id' | 'hash' | 'return';
  memo?: string;
  memo_bytes?: string;
  fee_charged: string;
  successful: boolean;
  operation_count: number;
  source_account: string;
  /** Account that paid the fee: differs from source_account for fee-bump transactions and channel setups. */
  fee_account?: string;
}

/** Effect record (only the fields this preview reads). */
export interface HorizonEffect {
  id: string;
  type: string;
  account?: string;
  amount?: string;
  asset_type?: string;
  asset_code?: string;
  asset_issuer?: string;
}

/** Horizon root document: the ledger range this instance serves history for. */
export interface HorizonRoot {
  history_latest_ledger: number;
  history_elder_ledger: number;
}

export interface HorizonAssetBalanceChange {
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
  type: 'transfer' | 'mint' | 'burn' | 'clawback';
  from?: string;
  to?: string;
  amount: string;
  destination_muxed_id?: string;
}

/** Operation record, as served by /payments and /operations (fields vary by type). */
export interface HorizonOperation {
  id: string;
  paging_token: string;
  transaction_successful: boolean;
  source_account: string;
  type: string;
  created_at: string;
  transaction_hash: string;
  transaction?: HorizonTransaction;
  // payment / path payments
  asset_type?: string;
  asset_code?: string;
  asset_issuer?: string;
  from?: string;
  from_muxed?: string;
  from_muxed_id?: string;
  to?: string;
  to_muxed?: string;
  to_muxed_id?: string;
  amount?: string;
  source_amount?: string;
  source_asset_type?: string;
  source_asset_code?: string;
  source_asset_issuer?: string;
  path?: Array<{ asset_type: string; asset_code?: string; asset_issuer?: string }>;
  // create_account
  account?: string;
  funder?: string;
  starting_balance?: string;
  // account_merge
  into?: string;
  // liquidity pools
  liquidity_pool_id?: string;
  reserves_deposited?: HorizonReserve[];
  reserves_received?: HorizonReserve[];
  shares_received?: string;
  shares?: string;
  // invoke_host_function
  function?: string;
  parameters?: Array<{ type: string; value: string }>;
  asset_balance_changes?: HorizonAssetBalanceChange[] | null;
  // change_trust and friends
  trustor?: string;
  trustee?: string;
  limit?: string;
  // offers
  selling_asset_type?: string;
  selling_asset_code?: string;
  buying_asset_type?: string;
  buying_asset_code?: string;
  price?: string;
}

export interface HorizonPage<T> {
  _embedded: { records: T[] };
  _links: { next?: { href: string } };
}

export interface HorizonPath {
  source_asset_type: string;
  source_amount: string;
  destination_asset_type: string;
  destination_asset_code?: string;
  destination_asset_issuer?: string;
  destination_amount: string;
  path: Array<{ asset_type: string; asset_code?: string; asset_issuer?: string }>;
}

export interface HorizonOffer {
  price: string;
  amount: string;
}

export interface HorizonOrderBook {
  bids: HorizonOffer[];
  asks: HorizonOffer[];
}

const get = <T>(path: string, ttlMs: number, nullOn?: readonly number[]) =>
  requestJson<T>(`${HORIZON_URL}${path}`, { ttlMs, limit: horizonLimit, nullOn });

/** Returns null when the account does not exist on the ledger (HTTP 404). */
export function getAccount(id: string, ttlMs = 10_000): Promise<HorizonAccount | null> {
  return get<HorizonAccount | null>(`/accounts/${id}`, ttlMs, [404]);
}

export async function getLatestLedger(): Promise<HorizonLedger> {
  const page = await get<HorizonPage<HorizonLedger>>('/ledgers?order=desc&limit=1', 4_000);
  const rec = page._embedded.records[0];
  if (!rec) throw new Error('Horizon returned no ledger');
  return rec;
}

/** Ledger range of this Horizon instance (public Horizon keeps about one year of history). */
export function getRoot(): Promise<HorizonRoot> {
  return get<HorizonRoot>('/', 10 * 60_000);
}

/** One closed ledger: immutable, cached for a day. */
export function getLedger(seq: number): Promise<HorizonLedger> {
  return get<HorizonLedger>(`/ledgers/${seq}`, 24 * 3_600_000);
}

/** Effects of one operation: immutable once closed, cached for an hour. */
export function getOperationEffects(operationId: string): Promise<HorizonPage<HorizonEffect>> {
  return get<HorizonPage<HorizonEffect>>(`/operations/${operationId}/effects?limit=20`, 3_600_000);
}

export function getLiquidityPool(id: string): Promise<HorizonLiquidityPool | null> {
  return get<HorizonLiquidityPool | null>(`/liquidity_pools/${id}`, 30_000, [404]);
}

/** Cursor of the next page, parsed from Horizon's `next` link. */
export function nextCursor(page: HorizonPage<unknown>): string | null {
  const href = page._links.next?.href;
  if (!href) return null;
  try {
    return new URL(href).searchParams.get('cursor');
  } catch {
    return null;
  }
}

export function getPayments(account: string, cursor?: string | null, limit: number = LIMITS.activityPage) {
  const c = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
  return get<HorizonPage<HorizonOperation>>(
    `/accounts/${account}/payments?order=desc&limit=${limit}&join=transactions${c}`,
    15_000,
  );
}

export function getOperations(account: string, cursor?: string | null, limit: number = LIMITS.activityPage) {
  const c = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
  return get<HorizonPage<HorizonOperation>>(
    `/accounts/${account}/operations?order=desc&limit=${limit}&join=transactions${c}`,
    15_000,
  );
}

/** Horizon asset query parameters for `prefix` (source_, selling_, buying_). */
export function assetParams(prefix: string, asset: string): string {
  if (asset === 'native') return `${prefix}asset_type=native`;
  const [code, issuer] = asset.split(':');
  const type = code.length <= 4 ? 'credit_alphanum4' : 'credit_alphanum12';
  return `${prefix}asset_type=${type}&${prefix}asset_code=${encodeURIComponent(code)}&${prefix}asset_issuer=${issuer}`;
}

/** Strict-send paths from `amount` of `source` to each destination (SDEX offers and classic pools). */
export function strictSendPaths(source: string, amount: string, destinations: readonly string[]) {
  const dest = destinations.map((d) => (d === 'native' ? 'native' : d)).join(',');
  return get<HorizonPage<HorizonPath>>(
    `/paths/strict-send?${assetParams('source_', source)}&source_amount=${amount}&destination_assets=${encodeURIComponent(dest)}`,
    60_000,
  );
}

export function getOrderBook(selling: string, buying: string, limit = 5) {
  return get<HorizonOrderBook>(
    `/order_book?${assetParams('selling_', selling)}&${assetParams('buying_', buying)}&limit=${limit}`,
    15_000,
  );
}

/** Open offers of `seller` selling `selling` for `buying` (used to spot an issuer's own mint offer). */
export function getSellerOffers(seller: string, selling: string, buying: string) {
  return get<HorizonPage<HorizonOffer & { seller: string }>>(
    `/offers?seller=${seller}&${assetParams('selling_', selling)}&${assetParams('buying_', buying)}&limit=1`,
    300_000,
  );
}

export function findLiquidityPools(reserves: readonly string[]) {
  return get<HorizonPage<HorizonLiquidityPool>>(
    `/liquidity_pools?reserves=${encodeURIComponent(reserves.join(','))}&limit=5`,
    60_000,
  );
}

/** Network-wide payments, newest first (used by the live test to find merges and contract swaps at run time). */
export function getNetworkPayments(cursor?: string | null, limit = 200) {
  const c = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
  return get<HorizonPage<HorizonOperation>>(`/payments?order=desc&limit=${limit}&join=transactions${c}`, 15_000);
}

/** Accounts holding shares of a pool (used by the live test to find an LP account). */
export function getPoolParticipants(poolId: string, limit = 10) {
  return get<HorizonPage<HorizonAccount>>(`/accounts?liquidity_pool=${poolId}&limit=${limit}`, 60_000);
}
