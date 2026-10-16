// Holdings of a Stellar account: XLM with reserves, trustlines, CAP-38 pool
// shares split into their reserves, and SEP-41 tokens from the registry,
// each with its USD valuation and the source of that valuation.

import { LIMITS, SEP41_REGISTRY, USDC_ID, explorer } from './config.ts';
import type { Sep41RegistryEntry } from './config.ts';
import { fromStroops, toNumber, toStroops, trimAmount } from './amount.ts';
import { getAccount, getLatestLedger, getLiquidityPool } from './horizon.ts';
import type { HorizonAccount, HorizonBalanceCredit, HorizonLedger, HorizonLiquidityPool } from './horizon.ts';
import { describeError } from './http.ts';
import { depthCheckNeeded, getXlmUsd, priceAsset, valueAtDepth } from './prices.ts';
import type { PriceResult, PriceSource } from './prices.ts';
import { assetCode, assetIssuer, readSep41, sacContractId } from './stellar.ts';
import type { AssetId, ParsedAddress } from './stellar.ts';
import { verifyAsset } from './toml.ts';
import type { Verification } from './toml.ts';

export type ValuationSource = PriceSource | 'underlying_reserves';

export interface Valuation {
  state: 'pending' | 'priced' | 'unpriced' | 'zero';
  priceUsd: number | null;
  valueUsd: number | null;
  source: ValuationSource | null;
  detail: string | null;
  /** Why the holding has no USD value (fail loud, never a guess). */
  reason: string | null;
  /** Value at depth divided by spot value, when the depth check ran. */
  depthRatio: number | null;
}

const pendingValuation = (): Valuation => ({
  state: 'pending',
  priceUsd: null,
  valueUsd: null,
  source: null,
  detail: null,
  reason: null,
  depthRatio: null,
});

export interface Reserves {
  baseReserveStroops: bigint;
  subentryCount: number;
  numSponsoring: number;
  numSponsored: number;
  /** (2 + subentries + sponsoring - sponsored) x base reserve. */
  minimumBalance: bigint;
  sellingLiabilities: bigint;
  buyingLiabilities: bigint;
  /** Minimum balance plus selling liabilities: XLM the account cannot send. */
  reserved: bigint;
  total: bigint;
  spendable: bigint;
}

export function computeReserves(input: {
  balance: bigint;
  subentryCount: number;
  numSponsoring: number;
  numSponsored: number;
  sellingLiabilities: bigint;
  buyingLiabilities: bigint;
  baseReserveStroops: bigint;
}): Reserves {
  const entries = BigInt(2 + input.subentryCount + input.numSponsoring - input.numSponsored);
  const minimumBalance = entries * input.baseReserveStroops;
  const reserved = minimumBalance + input.sellingLiabilities;
  const spendable = input.balance > reserved ? input.balance - reserved : 0n;
  return {
    baseReserveStroops: input.baseReserveStroops,
    subentryCount: input.subentryCount,
    numSponsoring: input.numSponsoring,
    numSponsored: input.numSponsored,
    minimumBalance,
    sellingLiabilities: input.sellingLiabilities,
    buyingLiabilities: input.buyingLiabilities,
    reserved,
    total: input.balance,
    spendable,
  };
}

interface HoldingBase {
  /** Row key, as the Serialized API keys rows: chain:address[:native|:stable]. */
  key: string;
  code: string;
  name: string | null;
  /** Decimal string, trailing zeros trimmed. */
  amount: string;
  decimals: number;
  lastModifiedLedger: number | null;
  valuation: Valuation;
  explorerUrl: string;
}

export interface NativeHolding extends HoldingBase {
  type: 'native';
  assetId: 'native';
  stroops: bigint;
  reserves: Reserves;
}

export interface TrustlineFlags {
  authorized: boolean;
  authorizedToMaintainLiabilities: boolean;
  clawbackEnabled: boolean;
}

export interface CreditHolding extends HoldingBase {
  type: 'credit';
  assetId: AssetId;
  assetType: 'credit_alphanum4' | 'credit_alphanum12';
  issuer: string;
  stroops: bigint;
  limit: string;
  buyingLiabilities: string;
  sellingLiabilities: string;
  sponsor: string | null;
  flags: TrustlineFlags;
  sacContractId: string;
  verification: Verification | null;
  /** 'stable' for Circle USDC (face value), 'position' otherwise. */
  apiKind: 'stable' | 'position';
}

export interface PoolReserveShare {
  assetId: AssetId;
  code: string;
  issuer: string | null;
  /** Whole pool reserve. */
  poolAmount: string;
  /** The account's share of that reserve. */
  amount: string;
  priceUsd: number | null;
  /** Value of the account's share of this reserve at market depth. */
  valueUsd: number | null;
  /** Depth value divided by spot value, when below 1. */
  depthRatio: number | null;
}

/**
 * A CAP-38 pool share. Its trustline carries no authorization flags of its
 * own (authorization follows the trustlines of the two pool assets), so none
 * are kept here: Horizon reports is_authorized false for every one of them.
 */
export interface PoolShareHolding extends HoldingBase {
  type: 'pool_share';
  poolId: string;
  stroops: bigint;
  limit: string;
  sponsor: string | null;
  pool: {
    feeBp: number;
    totalShares: string;
    totalTrustlines: number;
    sharePercent: number;
    reserves: PoolReserveShare[];
    lastModifiedLedger: number;
  } | null;
  poolError: string | null;
}

export interface Sep41Holding extends HoldingBase {
  type: 'sep41';
  contractId: string;
  raw: bigint;
  registry: Sep41RegistryEntry;
  checkedAtLedger: number;
}

export type Holding = NativeHolding | CreditHolding | PoolShareHolding | Sep41Holding;

export interface Sep41Check {
  entry: Sep41RegistryEntry;
  state: 'pending' | 'held' | 'none' | 'error';
  balance: string | null;
  symbol: string | null;
  error: string | null;
  ledger: number | null;
}

export interface Summary {
  totalValueUsd: number;
  /** Rows with a balance (empty trustlines excluded). */
  positions: number;
  /** Rows carrying a USD value. */
  valued: number;
  unpriced: number;
  pending: number;
}

export interface PositionsModel {
  address: ParsedAddress;
  account: HorizonAccount;
  ledger: HorizonLedger;
  /** When the holdings were read, unix ms. */
  asOf: number;
  holdings: Holding[];
  /** Trustlines with a zero balance (shown collapsed, left out of the API mirror). */
  emptyTrustlines: Holding[];
  sep41: Sep41Check[];
  xlm: PriceResult | null;
  summary: Summary;
  complete: boolean;
  errors: string[];
}

export class AccountNotFoundError extends Error {
  readonly account: string;
  constructor(account: string) {
    super('This account does not exist on Stellar mainnet (never funded, or merged).');
    this.name = 'AccountNotFoundError';
    this.account = account;
  }
}

const KNOWN_NAMES: Record<string, string> = { [USDC_ID]: 'USD Coin' };

function flagsOf(b: HorizonBalanceCredit): TrustlineFlags {
  return {
    authorized: b.is_authorized ?? false,
    authorizedToMaintainLiabilities: b.is_authorized_to_maintain_liabilities ?? false,
    clawbackEnabled: b.is_clawback_enabled ?? false,
  };
}

export function buildBaseHoldings(account: HorizonAccount, ledger: HorizonLedger): { holdings: Holding[]; empty: Holding[] } {
  const holdings: Holding[] = [];
  const empty: Holding[] = [];
  for (const b of account.balances) {
    if (b.asset_type === 'native') {
      const stroops = toStroops(b.balance);
      holdings.push({
        type: 'native',
        key: 'stellar:native:native',
        assetId: 'native',
        code: 'XLM',
        name: 'Stellar Lumens',
        amount: trimAmount(b.balance),
        decimals: 7,
        stroops,
        lastModifiedLedger: account.last_modified_ledger,
        valuation: pendingValuation(),
        explorerUrl: explorer.account(account.id),
        reserves: computeReserves({
          balance: stroops,
          subentryCount: account.subentry_count,
          numSponsoring: account.num_sponsoring,
          numSponsored: account.num_sponsored,
          sellingLiabilities: toStroops(b.selling_liabilities),
          buyingLiabilities: toStroops(b.buying_liabilities),
          baseReserveStroops: BigInt(ledger.base_reserve_in_stroops),
        }),
      });
    } else if (b.asset_type === 'liquidity_pool_shares') {
      const stroops = toStroops(b.balance);
      const h: PoolShareHolding = {
        type: 'pool_share',
        key: `stellar:${b.liquidity_pool_id}`,
        poolId: b.liquidity_pool_id,
        code: 'Pool share',
        name: null,
        amount: trimAmount(b.balance),
        decimals: 7,
        stroops,
        limit: trimAmount(b.limit),
        sponsor: b.sponsor ?? null,
        lastModifiedLedger: b.last_modified_ledger,
        valuation: pendingValuation(),
        explorerUrl: explorer.pool(b.liquidity_pool_id),
        pool: null,
        poolError: null,
      };
      (stroops > 0n ? holdings : empty).push(h);
    } else {
      const id = `${b.asset_code}:${b.asset_issuer}`;
      const stroops = toStroops(b.balance);
      const h: CreditHolding = {
        type: 'credit',
        key: id === USDC_ID ? `stellar:${id}:stable` : `stellar:${id}`,
        assetId: id,
        assetType: b.asset_type,
        code: b.asset_code,
        issuer: b.asset_issuer,
        name: KNOWN_NAMES[id] ?? null,
        amount: trimAmount(b.balance),
        decimals: 7,
        stroops,
        limit: trimAmount(b.limit),
        buyingLiabilities: trimAmount(b.buying_liabilities),
        sellingLiabilities: trimAmount(b.selling_liabilities),
        sponsor: b.sponsor ?? null,
        flags: flagsOf(b),
        lastModifiedLedger: b.last_modified_ledger,
        valuation: stroops > 0n ? pendingValuation() : zeroValuation(),
        explorerUrl: explorer.asset(b.asset_code, b.asset_issuer),
        sacContractId: sacContractId(id),
        verification: null,
        apiKind: id === USDC_ID ? 'stable' : 'position',
      };
      (stroops > 0n ? holdings : empty).push(h);
    }
  }
  return { holdings, empty };
}

function zeroValuation(): Valuation {
  return { ...pendingValuation(), state: 'zero', valueUsd: 0, reason: 'zero balance, not priced' };
}

const ORDER: Record<Holding['type'], number> = { native: 0, credit: 1, pool_share: 2, sep41: 3 };

export function computeSummary(holdings: readonly Holding[]): Summary {
  let total = 0;
  let valued = 0;
  let unpriced = 0;
  let pending = 0;
  for (const h of holdings) {
    const v = h.valuation;
    if (v.state === 'pending') pending++;
    else if (v.valueUsd !== null) {
      total += v.valueUsd;
      valued++;
    } else unpriced++;
  }
  return { totalValueUsd: total, positions: holdings.length, valued, unpriced, pending };
}

/** Rows sorted as the API sorts them: by value, unknown values last, then by type. */
export function sortHoldings(holdings: readonly Holding[]): Holding[] {
  return [...holdings].sort((a, b) => {
    const va = a.valuation.valueUsd;
    const vb = b.valuation.valueUsd;
    if (va !== null && vb !== null && va !== vb) return vb - va;
    if (va !== null && vb === null) return -1;
    if (va === null && vb !== null) return 1;
    return ORDER[a.type] - ORDER[b.type] || a.code.localeCompare(b.code);
  });
}

function priced(price: number, value: number, source: ValuationSource, detail: string, depthRatio: number | null = null): Valuation {
  return { state: 'priced', priceUsd: price, valueUsd: value, source, detail, reason: null, depthRatio };
}

function unpriced(reason: string, priceUsd: number | null = null, source: ValuationSource | null = null, detail: string | null = null): Valuation {
  return { state: 'unpriced', priceUsd, valueUsd: null, source, detail, reason, depthRatio: null };
}

export interface LoadOptions {
  /** Called with a fresh snapshot every time a part of the model resolves. */
  onUpdate?: (model: PositionsModel) => void;
  /** Skip the SEP-41 registry checks (faster tests). */
  skipSep41?: boolean;
}

/**
 * Loads the holdings of `address` and resolves when every valuation,
 * verification and SEP-41 check has settled. Intermediate snapshots are
 * emitted through `onUpdate` so a UI can render progressively.
 */
export async function loadPositions(address: ParsedAddress, opts: LoadOptions = {}): Promise<PositionsModel> {
  const [account, ledger] = await Promise.all([getAccount(address.account, 5_000), getLatestLedger()]);
  if (!account) throw new AccountNotFoundError(address.account);
  const { holdings, empty } = buildBaseHoldings(account, ledger);

  const model: PositionsModel = {
    address,
    account,
    ledger,
    asOf: Date.now(),
    holdings,
    emptyTrustlines: empty,
    sep41: SEP41_REGISTRY.map((entry) => ({ entry, state: 'pending', balance: null, symbol: null, error: null, ledger: null })),
    xlm: null,
    summary: computeSummary(holdings),
    complete: false,
    errors: [],
  };

  let scheduled = false;
  const emit = (force = false) => {
    model.summary = computeSummary(model.holdings);
    if (!opts.onUpdate) return;
    if (force) {
      opts.onUpdate(snapshot(model));
      return;
    }
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      opts.onUpdate?.(snapshot(model));
    }, 60);
  };
  emit(true);

  const replace = (key: string, patch: (h: Holding) => Holding) => {
    const update = (list: Holding[]) => list.map((h) => (h.key === key ? patch(h) : h));
    model.holdings = update(model.holdings);
    model.emptyTrustlines = update(model.emptyTrustlines);
  };

  const xlmP = getXlmUsd();

  // One price per asset per load, shared by trustline rows and pool reserves.
  const priceMemo = new Map<AssetId, Promise<PriceResult>>();
  const priceOf = async (asset: AssetId): Promise<PriceResult> => {
    const xlm = await xlmP;
    let p = priceMemo.get(asset);
    if (!p) {
      p = priceAsset(asset, xlm);
      priceMemo.set(asset, p);
    }
    return p;
  };

  // Gentle-use budget: price the first N holdings, ranked USDC, then pool
  // shares, then real balances (largest first), then dust of a few stroops
  // (often NFT-like tokens); verify the first M trustlines. A row beyond the
  // budget reuses a price already computed on this page, else says why it is
  // unpriced.
  const DUST_STROOPS = 10n;
  const stroopsOf = (h: Holding): bigint => ('stroops' in h ? h.stroops : 0n);
  const rank = (h: Holding) =>
    h.type === 'credit' && h.assetId === USDC_ID ? 0 : h.type === 'pool_share' ? 1 : stroopsOf(h) > DUST_STROOPS ? 2 : 3;
  const priceable = holdings.filter((h) => h.type !== 'native');
  const priority = [...priceable].sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    const sa = stroopsOf(a);
    const sb = stroopsOf(b);
    return sb > sa ? 1 : sb < sa ? -1 : 0;
  });
  const toPrice = new Set(priority.slice(0, LIMITS.maxPricedHoldings).map((h) => h.key));
  const verifiable = [...priority.filter((h) => toPrice.has(h.key)), ...holdings.filter((h) => !toPrice.has(h.key)), ...empty].filter(
    (h) => h.type === 'credit',
  );
  const toVerify = new Set(verifiable.slice(0, LIMITS.maxVerifiedTrustlines).map((h) => h.key));

  // Prices and depth values of the holdings within the budget.
  const pricing = holdings.map(async (h) => {
    if (h.type !== 'native' && !toPrice.has(h.key)) return; // priced (or not) once the budgeted rows are done
    const xlm = await xlmP;
    model.xlm = xlm;
    if (h.type === 'native') {
      replace(h.key, (x) => ({
        ...x,
        valuation: xlm.ok
          ? priced(xlm.price.usd, toNumber(h.stroops) * xlm.price.usd, xlm.price.source, xlm.price.detail)
          : unpriced(xlm.reason),
      }));
    } else if (h.type === 'credit') {
      const p = await priceOf(h.assetId);
      if (!p.ok) {
        replace(h.key, (x) => ({ ...x, valuation: unpriced(p.reason) }));
      } else {
        const amount = toNumber(h.stroops);
        const depth = await valueAtDepth(h.assetId, amount, p.price, xlm);
        replace(h.key, (x) => ({
          ...x,
          valuation: depth.ok
            ? priced(p.price.usd, depth.usd, p.price.source, p.price.detail, depth.ratio < 0.999 ? depth.ratio : null)
            : unpriced(depth.reason, p.price.usd, p.price.source, p.price.detail),
        }));
      }
    } else if (h.type === 'pool_share') {
      await valuePoolShare(h, xlm, priceOf, replace);
    }
    emit();
  });

  // Holdings beyond the budget: no new request. A price already computed on
  // this page (for another row or a pool reserve) is reused when the balance
  // is small enough not to need a depth check; anything else is unpriced,
  // with the reason.
  const beyondBudget = (async () => {
    await Promise.allSettled(pricing);
    let left = 0;
    for (const h of holdings) {
      if (h.type === 'native' || toPrice.has(h.key)) continue;
      const known = h.type === 'credit' ? priceMemo.get(h.assetId) : undefined;
      const p = known ? await known : null;
      if (h.type === 'credit' && p?.ok) {
        const amount = toNumber(h.stroops);
        if (!depthCheckNeeded(amount, p.price)) {
          replace(h.key, (x) => ({
            ...x,
            valuation: priced(p.price.usd, amount * p.price.usd, p.price.source, `${p.price.detail} (price already computed for another row of this account)`),
          }));
          continue;
        }
        replace(h.key, (x) => ({
          ...x,
          valuation: unpriced(
            `not priced: beyond this preview's budget of ${LIMITS.maxPricedHoldings} priced holdings; the unit price is known from another row, but the market-depth check of this balance was not run`,
            p.price.usd,
            p.price.source,
            p.price.detail,
          ),
        }));
        left++;
        continue;
      }
      replace(h.key, (x) => ({
        ...x,
        valuation: unpriced(`not priced: this preview prices at most ${LIMITS.maxPricedHoldings} holdings per account (gentle use of public Horizon)`),
      }));
      left++;
    }
    if (left > 0)
      model.errors.push(
        `${left} holdings left unpriced: this preview prices at most ${LIMITS.maxPricedHoldings} holdings per account to stay gentle with public Horizon.`,
      );
    emit();
  })();

  // SEP-1 verification of the trustline assets within the budget (empty ones included).
  const verifying = [...holdings, ...empty].map(async (h) => {
    if (h.type !== 'credit') return;
    const v: Verification = toVerify.has(h.key)
      ? await verifyAsset(h.code, h.issuer)
      : { status: 'not_checked', detail: `not checked: this preview verifies at most ${LIMITS.maxVerifiedTrustlines} trustlines per account` };
    replace(h.key, (x) => {
      if (x.type !== 'credit') return x;
      const name = x.name ?? (v.status === 'verified' ? v.currencyName : null);
      return { ...x, verification: v, name };
    });
    emit();
  });

  // SEP-41 registry checks.
  const sep41 = opts.skipSep41
    ? []
    : SEP41_REGISTRY.map(async (entry, i) => {
        try {
          const r = await readSep41(entry.contractId, address.account);
          const balance = fromStroops(r.balance, r.decimals);
          model.sep41 = model.sep41.map((c, j) =>
            j === i ? { ...c, state: r.balance > 0n ? 'held' : 'none', balance, symbol: r.symbol, ledger: r.latestLedger } : c,
          );
          if (r.balance > 0n) {
            model.holdings = [
              ...model.holdings,
              {
                type: 'sep41',
                key: `stellar:${entry.contractId}`,
                contractId: entry.contractId,
                code: r.symbol,
                name: r.name,
                amount: balance,
                decimals: r.decimals,
                raw: r.balance,
                registry: entry,
                checkedAtLedger: r.latestLedger,
                lastModifiedLedger: null,
                valuation: unpriced('no SDEX or classic pool market for a Soroban-native token in this preview'),
                explorerUrl: explorer.contract(entry.contractId),
              },
            ];
          }
        } catch (err) {
          model.sep41 = model.sep41.map((c, j) => (j === i ? { ...c, state: 'error', error: describeError(err) } : c));
        }
        emit();
      });

  const settled = await Promise.allSettled([...pricing, beyondBudget, ...verifying, ...sep41]);
  for (const s of settled) if (s.status === 'rejected') model.errors.push(describeError(s.reason));
  // Anything still pending after every task settled failed unexpectedly: say so.
  model.holdings = model.holdings.map((h) =>
    h.valuation.state === 'pending' ? { ...h, valuation: unpriced('valuation failed (see errors)') } : h,
  );
  model.holdings = sortHoldings(model.holdings);
  model.complete = true;
  emit(true);
  return snapshot(model);
}

async function valuePoolShare(
  h: PoolShareHolding,
  xlm: PriceResult,
  priceOf: (asset: AssetId) => Promise<PriceResult>,
  replace: (key: string, patch: (h: Holding) => Holding) => void,
): Promise<void> {
  let pool: HorizonLiquidityPool | null;
  try {
    pool = await getLiquidityPool(h.poolId);
  } catch (err) {
    replace(h.key, (x) => ({ ...x, poolError: describeError(err), valuation: unpriced(`pool unavailable: ${describeError(err)}`) }));
    return;
  }
  if (!pool) {
    replace(h.key, (x) => ({ ...x, poolError: 'pool not found', valuation: unpriced('pool not found on Horizon') }));
    return;
  }
  const totalShares = toStroops(pool.total_shares);
  const share = totalShares > 0n ? h.stroops : 0n;
  const reserves: PoolReserveShare[] = [];
  for (const r of pool.reserves) {
    const poolStroops = toStroops(r.amount);
    // Rounded down, as the protocol computes a withdrawal.
    const mine = totalShares > 0n ? (poolStroops * share) / totalShares : 0n;
    reserves.push({
      assetId: r.asset,
      code: assetCode(r.asset),
      issuer: assetIssuer(r.asset),
      poolAmount: trimAmount(r.amount),
      amount: fromStroops(mine),
      priceUsd: null,
      valueUsd: null,
      depthRatio: null,
    });
  }
  const sharePercent = totalShares > 0n ? (Number(share) / Number(totalShares)) * 100 : 0;
  const poolInfo = {
    feeBp: pool.fee_bp,
    totalShares: trimAmount(pool.total_shares),
    totalTrustlines: Number(pool.total_trustlines),
    sharePercent,
    reserves,
    lastModifiedLedger: pool.last_modified_ledger,
  };
  const name = `${reserves.map((r) => r.code).join('/')} pool share`;
  replace(h.key, (x) => ({ ...x, name, pool: poolInfo }));

  // Each reserve is valued as a trustline holding is: at market depth, the
  // proceeds of selling it now through the best SDEX/AMM path.
  const valued = await Promise.all(
    reserves.map(async (r): Promise<{ r: PoolReserveShare; spot: number; reason: string | null }> => {
      const p = await priceOf(r.assetId);
      if (!p.ok) return { r, spot: 0, reason: `${r.code}: ${p.reason}` };
      const amount = toNumber(r.amount);
      const spot = amount * p.price.usd;
      const depth = await valueAtDepth(r.assetId, amount, p.price, xlm);
      if (!depth.ok) return { r: { ...r, priceUsd: p.price.usd }, spot, reason: `${r.code}: ${depth.reason}` };
      return { r: { ...r, priceUsd: p.price.usd, valueUsd: depth.usd, depthRatio: depth.ratio < 0.999 ? depth.ratio : null }, spot, reason: null };
    }),
  );
  const missing = valued.map((v) => v.reason).filter((x): x is string => x !== null);
  const value = valued.reduce((s, v) => s + (v.r.valueUsd ?? 0), 0);
  const spot = valued.reduce((s, v) => s + v.spot, 0);
  const ratio = spot > 0 ? value / spot : 1;
  const shares = toNumber(h.stroops);
  replace(h.key, (x) => ({
    ...x,
    name,
    pool: { ...poolInfo, reserves: valued.map((v) => v.r) },
    valuation: missing.length
      ? unpriced(`underlying reserve unpriced (${missing.join('; ')})`)
      : priced(
          shares > 0 ? spot / shares : 0,
          value,
          'underlying_reserves',
          `your ${sharePercent.toPrecision(3)}% of the pool reserves, each valued at market depth (proceeds of selling it now through the best SDEX/AMM path)`,
          ratio < 0.999 ? ratio : null,
        ),
  }));
}

function snapshot(m: PositionsModel): PositionsModel {
  return {
    ...m,
    // Keep the ledger order while loading so rows do not jump; sorted by value once complete.
    holdings: [...m.holdings],
    emptyTrustlines: [...m.emptyTrustlines],
    sep41: [...m.sep41],
    summary: { ...m.summary },
    errors: [...m.errors],
  };
}
