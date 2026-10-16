// The JSON the Serialized Data API would serve for this account, in the
// envelope and field names of GET /v1/wallet/positions, /v1/wallet/transfers
// and /v1/wallet/swaps (EVM and Solana today). Stellar-specific fields live
// under a "stellar" sub-object on each item. Computed client-side in this
// preview: nothing here is served by api.serialized.xyz.

import { CHAIN_ID, USDC_ID, explorer } from './config.ts';
import { fromStroops, toNumber } from './amount.ts';
import type { ActivityRow, AssetAmount } from './activity.ts';
import type { Holding, PositionsModel } from './positions.ts';

/** The API rounds USD figures to 6 significant digits. */
export const usd6 = (n: number | null): number | null => (n === null || !Number.isFinite(n) ? null : Number(n.toPrecision(6)));

const pct4 = (n: number) => Number(n.toFixed(4));

export const positionsPath = (wallet: string) =>
  `/v1/wallet/positions?chain=${CHAIN_ID}&wallet=${wallet}&includeNative=true&includeStables=true&minValueUsd=0&minLiquidityUsd=0`;
export const transfersPath = (wallet: string) => `/v1/wallet/transfers?chain=${CHAIN_ID}&wallet=${wallet}&limit=50`;
export const swapsPath = (wallet: string) => `/v1/wallet/swaps?chain=${CHAIN_ID}&wallet=${wallet}&limit=50`;

/** Fields the Serialized API derives from the wallet's trade history. */
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
    valueAtDepthRatio: v.depthRatio === null ? null : Number(v.depthRatio.toFixed(4)),
  };
}

function positionItem(h: Holding, totalValueUsd: number) {
  const amountUsd = usd6(h.valuation.valueUsd);
  const share = amountUsd === null || totalValueUsd <= 0 ? null : pct4(((h.valuation.valueUsd ?? 0) / totalValueUsd) * 100);
  const common = {
    chain: CHAIN_ID,
    decimals: h.decimals,
    amount: h.amount,
    amountUsd,
    currentPriceUsd: usd6(h.valuation.priceUsd),
    marketCapUsd: null,
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
          sharePercent: h.pool ? Number(h.pool.sharePercent.toPrecision(6)) : null,
          reserves:
            h.pool?.reserves.map((r) => ({
              asset: r.assetId,
              poolAmount: r.poolAmount,
              amount: r.amount,
              amountUsd: usd6(r.valueUsd),
            })) ?? null,
          trustline: {
            authorized: h.flags.authorized,
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
        totalValueUsd: usd6(total),
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
        preview: true,
      },
    },
  };
}

const tokenSymbol = (a: AssetAmount) => (a.asset === 'native' ? 'XLM' : a.code);

/** USD value at transfer time: only known for Circle USDC (face value) in this preview. */
const faceUsd = (a: AssetAmount): number | null => (a.asset === USDC_ID ? usd6(Number(a.amount)) : null);

function stellarOf(r: ActivityRow) {
  return {
    operationId: r.id,
    operationType: r.operationType,
    memo: r.memo,
    muxedId: r.muxedId,
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
    explorerUrl: r.explorerUrl,
  };
}

/** Rows of /v1/wallet/transfers: every token movement in or out, except the wallet's own swaps. */
export function transfersJson(rows: readonly ActivityRow[], page: { hasMore: boolean; nextCursor: string | null }, asOf: number) {
  const data: unknown[] = [];
  for (const r of rows) {
    if (r.kind === 'swap' && r.direction === 'self') continue;
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
        stellar: stellarOf(r),
      });
    };
    for (const a of r.debit) push(a, 'out');
    for (const a of r.credit) push(a, 'in');
  }
  const ats = rows.map((r) => r.at);
  return {
    data,
    meta: {
      asOf,
      hasMore: page.hasMore,
      ...(page.hasMore && page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      oldestAt: ats.length ? Math.min(...ats) : null,
      stellar: { source: 'payments', preview: true },
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

/** Rows of /v1/wallet/swaps: the wallet's own path payments (source and destination are the wallet), one row per transaction. */
export function swapsJson(rows: readonly ActivityRow[], page: { hasMore: boolean; nextCursor: string | null }, asOf: number) {
  const byTx = new Map<string, ActivityRow[]>();
  for (const r of rows) {
    if (r.kind !== 'swap' || r.direction !== 'self' || !r.conversion) continue;
    const list = byTx.get(r.txHash) ?? [];
    list.push(r);
    byTx.set(r.txHash, list);
  }
  const net = (legs: AssetAmount[]): SwapAsset[] => {
    const sums = new Map<string, number>();
    for (const l of legs) sums.set(l.asset, (sums.get(l.asset) ?? 0) + toNumber(l.amount));
    return [...sums.entries()]
      .map(([asset, amount]) => ({ tokenAddress: asset, symbol: asset === 'native' ? 'XLM' : asset.split(':')[0], name: null, decimals: 7, amount }))
      .sort((a, b) => b.amount - a.amount);
  };
  const data = [...byTx.values()].map((legs) => {
    const first = legs[0];
    const sent = net(legs.map((l) => l.conversion!.source));
    const received = net(legs.map((l) => l.conversion!.destination));
    const xlmSide = [...sent, ...received].find((a) => a.tokenAddress === 'native');
    const usdcSide = [...sent, ...received].find((a) => a.tokenAddress === USDC_ID);
    return {
      id: first.txHash,
      at: first.at,
      chain: CHAIN_ID,
      txHash: first.txHash,
      block: first.ledger,
      sent,
      received,
      volumeNative: xlmSide ? xlmSide.amount : null,
      volumeUsd: usdcSide ? usd6(usdcSide.amount) : null,
      feesNative: first.feeXlm === null ? null : Number(first.feeXlm),
      route: null,
      stellar: {
        operations: legs.map((l) => ({ operationId: l.id, operationType: l.operationType, path: l.conversion!.path })),
        memo: first.memo,
        explorerUrl: explorer.tx(first.txHash),
      },
    };
  });
  const ats = rows.map((r) => r.at);
  return {
    data,
    meta: {
      asOf,
      hasMore: page.hasMore,
      usdBasis: 'usdc_face_value',
      ...(page.hasMore && page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      oldestAt: ats.length ? Math.min(...ats) : null,
      stellar: { source: 'payments', preview: true },
    },
  };
}
