// The JSON the Serialized Data API would serve for this account, in the
// envelope and field names of GET /v1/wallet/positions, /v1/wallet/transfers
// and /v1/wallet/swaps (EVM and Solana today). Stellar-specific fields live
// under a "stellar" sub-object on each item. Computed client-side in this
// preview: nothing here is served by the Serialized API.

import { CHAIN_ID, USDC_ID, explorer } from './config.ts';
import { fromStroops, toNumber, toStroops } from './amount.ts';
import type { ActivityRow, AssetAmount } from './activity.ts';
import type { Holding, PositionsModel } from './positions.ts';

/** USD figures are served unrounded, as the API serves them; NaN and infinities become null. */
const num = (n: number | null | undefined): number | null => (n === null || n === undefined || !Number.isFinite(n) ? null : n);

export const positionsPath = (wallet: string) =>
  `/v1/wallet/positions?chain=${CHAIN_ID}&wallet=${wallet}&includeNative=true&includeStables=true&minValueUsd=0&minLiquidityUsd=0`;
const withCursor = (cursor: string | null) => (cursor ? `&cursor=${cursor}` : '');
export const transfersPath = (wallet: string, cursor: string | null = null) =>
  `/v1/wallet/transfers?chain=${CHAIN_ID}&wallet=${wallet}&limit=50${withCursor(cursor)}`;
export const swapsPath = (wallet: string, cursor: string | null = null) =>
  `/v1/wallet/swaps?chain=${CHAIN_ID}&wallet=${wallet}&limit=50${withCursor(cursor)}`;

/**
 * Fields the Serialized API derives from the wallet's trade history. This
 * preview does not read trade history, so they are null on position rows,
 * and the payload says so in meta.stellar.tradeHistory. 0 would claim
 * "never traded", which the preview cannot know (the API serves 0 for a
 * holding it has seen arrive without a trade).
 */
const TRADE_FIELDS_NULL = {
  entryPriceUsd: null,
  entryPriceLifetimeUsd: null,
  exitPriceUsd: null,
  realizedPnlUsd: null,
  unrealizedPnlUsd: null,
  totalPnlUsd: null,
  boughtTokens: null,
  soldTokens: null,
  boughtUsd: null,
  soldUsd: null,
  buys: null,
  sells: null,
  firstTradeAt: null,
  lastTradeAt: null,
  holdingSince: null,
  buyFeesUsd: null,
  sellFeesUsd: null,
  totalFeesUsd: null,
} as const;

/** Native and stable rows carry no PnL in the API: zeros, as served on EVM and Solana. */
const FACE_VALUE_TRADE_FIELDS = {
  entryPriceUsd: null,
  entryPriceLifetimeUsd: null,
  exitPriceUsd: null,
  realizedPnlUsd: 0,
  unrealizedPnlUsd: null,
  totalPnlUsd: 0,
  boughtTokens: '0',
  soldTokens: '0',
  boughtUsd: 0,
  soldUsd: 0,
  buys: 0,
  sells: 0,
  firstTradeAt: null,
  lastTradeAt: null,
  holdingSince: null,
  buyFeesUsd: null,
  sellFeesUsd: null,
  totalFeesUsd: null,
} as const;

/** Field order of a /v1/wallet/positions row, as served on EVM and Solana. */
export const POSITION_FIELDS = [
  'key', 'chain', 'address', 'symbol', 'name', 'iconUrl', 'kind', 'decimals', 'amount', 'amountUsd',
  'entryPriceUsd', 'entryPriceLifetimeUsd', 'currentPriceUsd', 'marketCapUsd', 'exitPriceUsd',
  'realizedPnlUsd', 'unrealizedPnlUsd', 'totalPnlUsd', 'boughtTokens', 'soldTokens', 'boughtUsd', 'soldUsd',
  'buys', 'sells', 'firstTradeAt', 'lastTradeAt', 'holdingSince', 'buyFeesUsd', 'sellFeesUsd', 'totalFeesUsd',
  'labels', 'share',
] as const;

/** Trade-derived fields left null on position rows in this preview (see TRADE_FIELDS_NULL). */
export const PREVIEW_NULL_FIELDS = Object.keys(TRADE_FIELDS_NULL) as ReadonlyArray<keyof typeof TRADE_FIELDS_NULL>;

/** Re-emits a row in the API's field order, with the Stellar sub-object last. */
function inApiOrder(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of POSITION_FIELDS) out[f] = row[f];
  out.stellar = row.stellar;
  return out;
}

function valuationFields(h: Holding) {
  const v = h.valuation;
  return {
    priceSource: v.source,
    priceDetail: v.detail,
    unpricedReason: v.state === 'unpriced' ? v.reason : null,
    valueAtDepthRatio: num(v.depthRatio),
  };
}

function positionItem(h: Holding, totalValueUsd: number) {
  const amountUsd = num(h.valuation.valueUsd);
  const share = amountUsd === null || totalValueUsd <= 0 ? null : (amountUsd / totalValueUsd) * 100;
  const common = {
    decimals: h.decimals,
    amount: h.amount,
    amountUsd,
    currentPriceUsd: num(h.valuation.priceUsd),
    labels: [] as string[],
    share,
  };
  switch (h.type) {
    case 'native':
      return {
        key: h.key,
        chain: CHAIN_ID,
        address: 'native',
        symbol: 'XLM',
        name: 'Stellar Lumens',
        iconUrl: null,
        kind: 'native',
        decimals: common.decimals,
        amount: common.amount,
        amountUsd: common.amountUsd,
        currentPriceUsd: common.currentPriceUsd,
        marketCapUsd: null,
        ...FACE_VALUE_TRADE_FIELDS,
        labels: common.labels,
        share: common.share,
        stellar: {
          assetType: 'native',
          reserves: {
            total: fromStroops(h.reserves.total),
            minimumBalance: fromStroops(h.reserves.minimumBalance),
            sellingLiabilities: fromStroops(h.reserves.sellingLiabilities),
            buyingLiabilities: fromStroops(h.reserves.buyingLiabilities),
            reserved: fromStroops(h.reserves.reserved),
            spendable: fromStroops(h.reserves.spendable),
            baseReserve: fromStroops(h.reserves.baseReserveStroops),
            subentryCount: h.reserves.subentryCount,
            numSponsoring: h.reserves.numSponsoring,
            numSponsored: h.reserves.numSponsored,
            formula: '(2 + subentryCount + numSponsoring - numSponsored) x baseReserve + sellingLiabilities',
          },
          lastModifiedLedger: h.lastModifiedLedger,
          ...valuationFields(h),
          explorerUrl: h.explorerUrl,
        },
      };
    case 'credit': {
      const v = h.verification;
      return {
        key: h.key,
        chain: CHAIN_ID,
        address: h.assetId,
        symbol: h.code,
        name: h.name,
        iconUrl: null,
        kind: h.apiKind,
        decimals: common.decimals,
        amount: common.amount,
        amountUsd: common.amountUsd,
        currentPriceUsd: common.currentPriceUsd,
        marketCapUsd: null,
        ...(h.apiKind === 'stable' ? FACE_VALUE_TRADE_FIELDS : TRADE_FIELDS_NULL),
        labels: common.labels,
        share: common.share,
        stellar: {
          assetType: h.assetType,
          code: h.code,
          issuer: h.issuer,
          homeDomain: v && 'domain' in v ? v.domain : null,
          verified: v?.status === 'verified',
          verification: v ? { status: v.status, detail: 'detail' in v ? v.detail : null } : null,
          sacContractId: h.sacContractId,
          trustline: {
            authorized: h.flags.authorized,
            authorizedToMaintainLiabilities: h.flags.authorizedToMaintainLiabilities,
            clawbackEnabled: h.flags.clawbackEnabled,
            limit: h.limit,
            buyingLiabilities: h.buyingLiabilities,
            sellingLiabilities: h.sellingLiabilities,
            sponsor: h.sponsor,
            lastModifiedLedger: h.lastModifiedLedger,
          },
          ...valuationFields(h),
          explorerUrl: h.explorerUrl,
        },
      };
    }
    case 'pool_share':
      return {
        key: h.key,
        chain: CHAIN_ID,
        address: h.poolId,
        symbol: h.pool ? h.pool.reserves.map((r) => r.code).join('/') : 'POOL',
        name: h.name,
        iconUrl: null,
        kind: 'position',
        decimals: common.decimals,
        amount: common.amount,
        amountUsd: common.amountUsd,
        currentPriceUsd: common.currentPriceUsd,
        marketCapUsd: null,
        ...TRADE_FIELDS_NULL,
        labels: common.labels,
        share: common.share,
        stellar: {
          assetType: 'liquidity_pool_shares',
          poolId: h.poolId,
          poolType: 'constant_product',
          feeBp: h.pool?.feeBp ?? null,
          totalShares: h.pool?.totalShares ?? null,
          totalTrustlines: h.pool?.totalTrustlines ?? null,
          sharePercent: h.pool ? h.pool.sharePercent : null,
          reserves:
            h.pool?.reserves.map((r) => ({
              asset: r.assetId,
              poolAmount: r.poolAmount,
              amount: r.amount,
              priceUsd: num(r.priceUsd),
              amountUsd: num(r.valueUsd),
              valueAtDepthRatio: num(r.depthRatio),
            })) ?? null,
          // CAP-38: a pool-share trustline carries no authorization flags of
          // its own; authorization follows the trustlines of the two assets.
          trustline: {
            limit: h.limit,
            sponsor: h.sponsor,
            lastModifiedLedger: h.lastModifiedLedger,
          },
          ...valuationFields(h),
          explorerUrl: h.explorerUrl,
        },
      };
    case 'sep41':
      return {
        key: h.key,
        chain: CHAIN_ID,
        address: h.contractId,
        symbol: h.code,
        name: h.name,
        iconUrl: null,
        kind: 'position',
        decimals: common.decimals,
        amount: common.amount,
        amountUsd: common.amountUsd,
        currentPriceUsd: common.currentPriceUsd,
        marketCapUsd: null,
        ...TRADE_FIELDS_NULL,
        labels: common.labels,
        share: common.share,
        stellar: {
          assetType: 'sep41',
          contractId: h.contractId,
          project: h.registry.project,
          readAtLedger: h.checkedAtLedger,
          ...valuationFields(h),
          explorerUrl: h.explorerUrl,
        },
      };
  }
}

export function positionsJson(m: PositionsModel) {
  const total = m.summary.totalValueUsd;
  const data = m.holdings.map((h) => inApiOrder(positionItem(h, total)));
  return {
    data,
    meta: {
      asOf: m.asOf,
      summary: {
        totalValueUsd: num(total),
        // Wallet-level PnL needs the trade history: null in this preview (see meta.stellar.tradeHistory).
        realizedPnlUsd: null,
        unrealizedPnlUsd: null,
        totalPnlUsd: null,
        positions: m.summary.positions,
        valued: m.summary.valued,
      },
      hasMore: false,
      stellar: {
        account: m.account.id,
        muxedId: m.address.muxedId,
        ledger: m.ledger.sequence,
        baseReserve: fromStroops(BigInt(m.ledger.base_reserve_in_stroops)),
        emptyTrustlines: m.emptyTrustlines.length,
        sep41Checked: m.sep41.map((c) => c.entry.contractId),
        tradeHistory: 'not_indexed_in_preview',
        preview: true,
      },
    },
  };
}

const tokenSymbol = (a: AssetAmount) => (a.asset === 'native' ? 'XLM' : a.code);

/** USD value at transfer time: only known for Circle USDC (face value) in this preview. */
const faceUsd = (a: AssetAmount): number | null => (a.asset === USDC_ID ? num(Number(a.amount)) : null);

function stellarOf(r: ActivityRow) {
  return {
    operationId: r.id,
    operationType: r.operationType,
    memo: r.memo,
    fromMuxedId: r.fromMuxedId,
    toMuxedId: r.toMuxedId,
    ledger: r.ledger,
    conversion: r.conversion
      ? {
          sourceAsset: r.conversion.source.asset,
          sourceAmount: r.conversion.source.amount,
          destinationAsset: r.conversion.destination.asset,
          destinationAmount: r.conversion.destination.amount,
          path: r.conversion.path,
        }
      : null,
    contract: r.contract ? { id: r.contract.id, function: r.contract.fn } : null,
    explorerUrl: r.explorerUrl,
  };
}

export interface ActivityJsonContext {
  /** Base G account of the page. */
  wallet: string;
  /** Muxed id when an M address was entered (directions are relative to it). */
  muxedId: string | null;
  /** When the page was read from Horizon, unix ms. */
  asOf: number;
  /** Earliest instant Horizon serves history for, unix ms (null when unknown). */
  historyFrom: number | null;
}

/** True for the account's own swaps (path payments and contract swaps): they belong to /swaps, not /transfers. */
const isOwnSwap = (r: ActivityRow) => r.kind === 'swap' && r.direction === 'self';

/**
 * Rows of /v1/wallet/transfers: every token movement in or out of the
 * account, one row per asset moved. A transaction that only swapped adds
 * none, as in the API; payments to self add none.
 */
export function transfersJson(rows: readonly ActivityRow[], page: { hasMore: boolean; nextCursor: string | null }, ctx: ActivityJsonContext) {
  const data: Array<Record<string, unknown> & { at: number }> = [];
  for (const r of rows) {
    if (isOwnSwap(r)) continue;
    // A payment to self moves nothing in or out. Contract calls that took and
    // paid back the same asset (not a swap) are real movements both ways.
    if (r.direction === 'self' && r.kind !== 'contract') continue;
    const push = (a: AssetAmount, direction: 'in' | 'out') => {
      if (a.asset.startsWith('pool:')) return;
      data.push({
        at: r.at,
        chain: CHAIN_ID,
        txHash: r.txHash,
        direction,
        tokenAddress: a.asset,
        tokenSymbol: tokenSymbol(a),
        amount: a.amount,
        amountUsd: faceUsd(a),
        counterparty: r.counterparty,
        stellar: { ...stellarOf(r), supplyEvent: a.event ?? null },
      });
    };
    for (const a of r.debit) push(a, 'out');
    for (const a of r.credit) push(a, 'in');
  }
  return {
    data,
    meta: {
      asOf: ctx.asOf,
      hasMore: page.hasMore,
      ...(page.hasMore && page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      ...(data.length ? { oldestAt: Math.min(...data.map((d) => d.at)) } : {}),
      ...(ctx.historyFrom !== null ? { historyFrom: ctx.historyFrom } : {}),
      stellar: { source: 'horizon_payments', pageUnit: 'operations', muxedId: ctx.muxedId, preview: true },
    },
  };
}

interface SwapAsset {
  tokenAddress: string;
  symbol: string;
  name: null;
  decimals: number;
  amount: number;
}

const symbolOf = (asset: string) => (asset === 'native' ? 'XLM' : asset.split(':')[0]);

/**
 * Net flows of a transaction's swap legs, as the API nets them: what left the
 * wallet is `sent`, what arrived is `received`, an asset that only passed
 * through cancels out. Exact on stroops, largest first.
 */
function netFlows(legs: readonly ActivityRow[]): { sent: SwapAsset[]; received: SwapAsset[] } {
  const net = new Map<string, bigint>();
  for (const l of legs) {
    for (const a of l.debit) net.set(a.asset, (net.get(a.asset) ?? 0n) - toStroops(a.amount));
    for (const a of l.credit) net.set(a.asset, (net.get(a.asset) ?? 0n) + toStroops(a.amount));
  }
  const sent: SwapAsset[] = [];
  const received: SwapAsset[] = [];
  for (const [asset, v] of net) {
    if (v === 0n) continue;
    const row = { tokenAddress: asset, symbol: symbolOf(asset), name: null, decimals: 7, amount: toNumber(v < 0n ? -v : v) };
    (v < 0n ? sent : received).push(row);
  }
  const byAmount = (a: SwapAsset, b: SwapAsset) => b.amount - a.amount;
  return { sent: sent.sort(byAmount), received: received.sort(byAmount) };
}

/**
 * Rows of /v1/wallet/swaps: the account's own swaps, one row per
 * transaction. On Stellar these are path payments whose source and
 * destination are both the account, and Soroban contract calls that took one
 * asset and paid another (AMM and aggregator swaps through Stellar Asset
 * Contracts).
 */
export function swapsJson(rows: readonly ActivityRow[], page: { hasMore: boolean; nextCursor: string | null }, ctx: ActivityJsonContext) {
  const byTx = new Map<string, ActivityRow[]>();
  for (const r of rows) {
    if (!isOwnSwap(r)) continue;
    const list = byTx.get(r.txHash) ?? [];
    list.push(r);
    byTx.set(r.txHash, list);
  }
  const data = [...byTx.values()].map((legs) => {
    const first = legs[0];
    const { sent, received } = netFlows(legs);
    const xlmSide = [...sent, ...received].find((a) => a.tokenAddress === 'native');
    const usdcSide = [...sent, ...received].find((a) => a.tokenAddress === USDC_ID);
    // The API's feesNative is the fee this wallet paid for the transaction:
    // 0 when another account (a channel or fee-bump account) paid it.
    const feesNative = first.feeXlm === null || first.feePaidBy === null ? null : first.feePaidBy === ctx.wallet ? Number(first.feeXlm) : 0;
    return {
      id: first.txHash,
      at: first.at,
      chain: CHAIN_ID,
      txHash: first.txHash,
      block: first.ledger,
      sent,
      received,
      volumeNative: xlmSide ? xlmSide.amount : null,
      volumeUsd: usdcSide ? usdcSide.amount : null,
      feesNative,
      // Per-hop venues (SDEX offers, classic pools, Soroban pools) come from
      // trade effects and contract events, read by our own ingestion.
      route: [],
      stellar: {
        operations: legs.map((l) => ({
          operationId: l.id,
          operationType: l.operationType,
          path: l.contract ? null : (l.conversion?.path ?? null),
          contract: l.contract ? { id: l.contract.id, function: l.contract.fn } : null,
        })),
        memo: first.memo,
        feeXlm: first.feeXlm,
        feePaidBy: first.feePaidBy,
        explorerUrl: explorer.tx(first.txHash),
      },
    };
  });
  return {
    data,
    meta: {
      asOf: ctx.asOf,
      hasMore: page.hasMore,
      usdBasis: 'usdc_face_value',
      ...(page.hasMore && page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      ...(data.length ? { oldestAt: Math.min(...data.map((d) => d.at)) } : {}),
      stellar: { source: 'horizon_payments', pageUnit: 'operations', route: 'not_in_preview', muxedId: ctx.muxedId, preview: true },
    },
  };
}
