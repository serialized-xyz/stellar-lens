// USD prices from public Stellar markets. Circle USDC is the USD unit.
// XLM/USD: SDEX order book mid against USDC, cross-checked with the classic
// XLM/USDC pool. Other assets: Horizon strict-send paths to USDC or XLM, which
// route through SDEX offers and classic (CAP-38) pools. Every price that fails
// a guard is returned as unpriced with its reason: never a guessed value.

import { USDC_ID, USDC_ISSUER } from './config.ts';
import { findLiquidityPools, getOrderBook, getSellerOffers, strictSendPaths } from './horizon.ts';
import type { HorizonPath } from './horizon.ts';
import { describeError } from './http.ts';
import { assetCode } from './stellar.ts';
import type { AssetId } from './stellar.ts';

export type PriceSource = 'usdc_peg' | 'sdex_orderbook_mid' | 'sdex_amm_path';

export interface Price {
  usd: number;
  source: PriceSource;
  /** Human-readable trace of how the price was obtained. */
  detail: string;
}

export type PriceResult = { ok: true; price: Price } | { ok: false; reason: string };

/** Hard bounds: anything outside is rejected as absurd. */
const MAX_UNIT_PRICE_USD = 1_000_000;
const MIN_UNIT_PRICE_USD = 1e-12;
/** XLM sanity window and cross-check tolerances. */
const XLM_MIN_USD = 0.001;
const XLM_MAX_USD = 100;
const XLM_MAX_SPREAD = 0.02;
const XLM_MAX_POOL_DIVERGENCE = 0.03;
/** Notional of the pricing probe, in USD. */
const PROBE_USD = 10;

export const fmtPrice = (p: number) => (p >= 1 ? p.toFixed(4) : p.toPrecision(4));

let xlmPromise: { at: number; p: Promise<PriceResult> } | null = null;

/** XLM/USD, cached 30 s. */
export function getXlmUsd(): Promise<PriceResult> {
  if (xlmPromise && Date.now() - xlmPromise.at < 30_000) return xlmPromise.p;
  const p = computeXlmUsd();
  xlmPromise = { at: Date.now(), p };
  return p;
}

async function computeXlmUsd(): Promise<PriceResult> {
  try {
    const [book, pools] = await Promise.all([
      getOrderBook('native', USDC_ID, 5),
      // The cross-check is a second opinion: when it cannot run, the trace says so.
      findLiquidityPools(['native', USDC_ID]).catch((err: unknown) => ({ unavailable: describeError(err) })),
    ]);
    const bid = Number(book.bids[0]?.price);
    const ask = Number(book.asks[0]?.price);
    if (!(bid > 0) || !(ask > 0)) return { ok: false, reason: 'XLM/USDC order book has no bid or no ask' };
    const mid = (bid + ask) / 2;
    const spread = (ask - bid) / mid;
    if (spread < 0) return { ok: false, reason: 'XLM/USDC order book is crossed' };
    if (spread > XLM_MAX_SPREAD) return { ok: false, reason: `XLM/USDC spread ${(spread * 100).toFixed(2)}% is too wide` };
    if (mid < XLM_MIN_USD || mid > XLM_MAX_USD) return { ok: false, reason: `XLM/USDC mid ${mid} outside sanity bounds` };
    let detail = `SDEX order book XLM/USDC: bid ${fmtPrice(bid)}, ask ${fmtPrice(ask)}, mid ${fmtPrice(mid)}`;
    const pool = 'unavailable' in pools ? null : pools._embedded.records[0];
    if ('unavailable' in pools) detail += `; classic pool cross-check unavailable (${pools.unavailable})`;
    else if (!pool) detail += '; classic pool cross-check not run (no XLM/USDC classic pool found)';
    if (pool) {
      const xlm = Number(pool.reserves.find((r) => r.asset === 'native')?.amount);
      const usdc = Number(pool.reserves.find((r) => r.asset === USDC_ID)?.amount);
      if (!(xlm > 10_000 && usdc > 0)) detail += '; classic pool cross-check not run (pool too small)';
      else {
        const poolPrice = usdc / xlm;
        const div = Math.abs(mid - poolPrice) / poolPrice;
        if (div > XLM_MAX_POOL_DIVERGENCE)
          return {
            ok: false,
            reason: `XLM price sources disagree: order book mid ${fmtPrice(mid)} vs classic pool ${fmtPrice(poolPrice)} (${(div * 100).toFixed(1)}%)`,
          };
        detail += `; classic pool XLM/USDC ${fmtPrice(poolPrice)} (agrees within ${(div * 100).toFixed(2)}%)`;
      }
    }
    return { ok: true, price: { usd: mid, source: 'sdex_orderbook_mid', detail } };
  } catch (err) {
    return { ok: false, reason: `XLM/USDC market unavailable: ${describeError(err)}` };
  }
}

interface Proceeds {
  usd: number;
  record: HorizonPath;
}

function pathLabel(rec: HorizonPath): string {
  const hops = rec.path.map((h) => (h.asset_type === 'native' ? 'XLM' : (h.asset_code ?? '?')));
  return hops.length ? ` via ${hops.join(' > ')}` : ' (direct)';
}

/** Best USD proceeds of selling `amount` of `asset` into SDEX + classic pools, toward USDC or XLM. */
async function bestProceeds(asset: AssetId, amount: string, xlmUsd: number | null): Promise<Proceeds | null> {
  const dest = xlmUsd ? [USDC_ID, 'native'] : [USDC_ID];
  const page = await strictSendPaths(asset, amount, dest);
  let best: Proceeds | null = null;
  for (const rec of page._embedded.records) {
    const out = Number(rec.destination_amount);
    let usd: number | null = null;
    if (rec.destination_asset_type === 'native') usd = xlmUsd ? out * xlmUsd : null;
    else if (`${rec.destination_asset_code}:${rec.destination_asset_issuer}` === USDC_ID) usd = out;
    if (usd !== null && Number.isFinite(usd) && (!best || usd > best.usd)) best = { usd, record: rec };
  }
  return best;
}

/** A 7-decimal amount string, within Horizon's accepted range. */
function amountString(units: number): string | null {
  if (!Number.isFinite(units) || units <= 0) return null;
  const clamped = Math.min(units, 900_000_000_000);
  const s = clamped.toFixed(7);
  return Number(s) > 0 ? s : null;
}

/**
 * Unit price of a classic asset in USD, from a strict-send probe of about
 * PROBE_USD of notional (sized from a first 1-unit probe).
 */
export async function priceAsset(asset: AssetId, xlm: PriceResult): Promise<PriceResult> {
  if (asset === USDC_ID)
    return { ok: true, price: { usd: 1, source: 'usdc_peg', detail: 'Circle USDC, valued at face value (1 USD)' } };
  if (asset === 'native') return xlm;
  const xlmUsd = xlm.ok ? xlm.price.usd : null;
  const code = assetCode(asset);
  try {
    const first = await bestProceeds(asset, '1.0000000', xlmUsd);
    if (!first || first.usd <= 0)
      return {
        ok: false,
        reason: xlmUsd
          ? 'no SDEX or classic pool path to USDC or XLM'
          : `no path to USDC (XLM itself is unpriced: ${xlm.ok ? '' : xlm.reason})`,
      };
    let unit = first.usd;
    let probe = first;
    let probeAmount = '1';
    if (unit < 1 || unit > 100) {
      const amt = amountString(PROBE_USD / unit);
      if (!amt) return { ok: false, reason: 'probe amount out of range' };
      const second = await bestProceeds(asset, amt, xlmUsd);
      if (!second || second.usd <= 0) return { ok: false, reason: `market too thin: no path for a ${PROBE_USD} USD probe` };
      const unit2 = second.usd / Number(amt);
      if (unit < 1 && unit2 < unit * 0.5)
        return {
          ok: false,
          reason: `market too thin: a ${PROBE_USD} USD probe moves the price by ${Math.round((1 - unit2 / unit) * 100)}%`,
        };
      unit = unit2;
      probe = second;
      probeAmount = String(Number(amt));
    }
    if (!Number.isFinite(unit) || unit < MIN_UNIT_PRICE_USD || unit > MAX_UNIT_PRICE_USD)
      return { ok: false, reason: `absurd price rejected (${unit} USD per ${code})` };
    const destCode = probe.record.destination_asset_type === 'native' ? 'XLM' : 'USDC';
    // When the route goes through USDC, check whether the USDC issuer itself
    // sells newly minted USDC for this asset (a mint facility such as Circle's
    // allowance token): that conversion is not a market, so it is not a price.
    const touchesUsdc =
      destCode === 'USDC' || probe.record.path.some((h) => `${h.asset_code}:${h.asset_issuer}` === USDC_ID);
    if (touchesUsdc) {
      const mint = await getSellerOffers(USDC_ISSUER, USDC_ID, asset);
      if (mint._embedded.records.length)
        return {
          ok: false,
          reason: `the USDC issuer itself converts ${code} into newly minted USDC (offer at ${mint._embedded.records[0].price}): a mint facility, not a market price`,
        };
    }
    return {
      ok: true,
      price: {
        usd: unit,
        source: 'sdex_amm_path',
        detail: `strict-send ${probeAmount} ${code} > ${Number(probe.record.destination_amount)} ${destCode}${pathLabel(probe.record)}${destCode === 'XLM' ? ' at XLM/USD' : ''}`,
      },
    };
  } catch (err) {
    return { ok: false, reason: `path finding failed: ${describeError(err)}` };
  }
}

export type DepthValue = { ok: true; usd: number; ratio: number } | { ok: false; reason: string };

/** Whether valuing `amount` at depth needs a path-finding request (path-priced holdings worth more than 2 probes). */
export function depthCheckNeeded(amount: number, price: Price): boolean {
  return price.source === 'sdex_amm_path' && amount * price.usd > PROBE_USD * 2;
}

/**
 * Value of a whole holding at market depth: the USD proceeds of selling the
 * full amount through the best path (as the Serialized API values positions
 * at the depth of their main pool). Small holdings use the unit price.
 */
export async function valueAtDepth(asset: AssetId, amount: number, price: Price, xlm: PriceResult): Promise<DepthValue> {
  const spot = amount * price.usd;
  if (!depthCheckNeeded(amount, price)) return { ok: true, usd: spot, ratio: 1 };
  const amt = amountString(amount);
  if (!amt) return { ok: true, usd: spot, ratio: 1 };
  try {
    const res = await bestProceeds(asset, amt, xlm.ok ? xlm.price.usd : null);
    if (!res) return { ok: false, reason: 'the full balance exceeds what SDEX and classic pools can absorb' };
    const usd = Math.min(res.usd, spot);
    return { ok: true, usd, ratio: spot > 0 ? usd / spot : 1 };
  } catch (err) {
    return { ok: false, reason: `depth check failed: ${describeError(err)}` };
  }
}
