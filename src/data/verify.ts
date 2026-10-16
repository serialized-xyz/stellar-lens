// "Verify" reads a holding's ledger entry straight from Stellar RPC
// (getLedgerEntries) and compares it with the value the page shows, which
// came from Horizon. A difference is shown as is, never smoothed over.

import { fromStroops } from './amount.ts';
import type { Holding } from './positions.ts';
import { computeReserves } from './positions.ts';
import { describeError } from './http.ts';
import {
  TRUSTLINE_FLAGS,
  accountKey,
  decodeAccount,
  decodeLiquidityPool,
  decodeTrustline,
  liquidityPoolKey,
  poolShareTrustlineKey,
  readEntries,
  readSep41,
  trustlineKey,
} from './stellar.ts';

export type VerifyStatus =
  /** Same entry version, same values. */
  | 'match'
  /** The entry changed on the ledger after the page loaded: newer values shown. */
  | 'changed'
  /** Same entry version but different values: a real discrepancy. */
  | 'mismatch'
  /** The entry does not exist on the ledger. */
  | 'missing'
  | 'error';

export interface FieldCheck {
  field: string;
  shown: string;
  ledger: string;
  equal: boolean;
}

export interface VerifyResult {
  status: VerifyStatus;
  /** Latest ledger of the RPC node that answered. */
  ledger: number | null;
  /** Ledger in which the entry was last modified, per RPC. */
  entryLastModified: number | null;
  /** Ledger in which the entry was last modified, per the data shown (Horizon). */
  shownLastModified: number | null;
  checks: FieldCheck[];
  endpoint: string | null;
  message: string;
}

function outcome(
  checks: FieldCheck[],
  rpcLast: number,
  shownLast: number | null,
  latestLedger: number,
  endpoint: string,
  what: string,
): VerifyResult {
  const allEqual = checks.every((c) => c.equal);
  const n = (x: number) => `#${x.toLocaleString('en-US')}`;
  const base = { ledger: latestLedger, entryLastModified: rpcLast, shownLastModified: shownLast, checks, endpoint };
  if (allEqual) return { ...base, status: 'match', message: `Matches ledger state ${n(latestLedger)} (${what})` };
  if (shownLast !== null && rpcLast > shownLast)
    return {
      ...base,
      status: 'changed',
      message: `Newer ledger state: the ${what} changed in ledger ${n(rpcLast)}, after this page loaded (shown data is from ${n(shownLast)}). Refresh to update.`,
    };
  return { ...base, status: 'mismatch', message: `Mismatch: the ${what} shown differs from ledger state ${n(latestLedger)}` };
}

const check = (field: string, shown: string, ledger: string): FieldCheck => ({ field, shown, ledger, equal: shown === ledger });

/** Verifies one holding against the ledger. Never throws. */
export async function verifyHolding(h: Holding, account: string): Promise<VerifyResult> {
  try {
    switch (h.type) {
      case 'native': {
        const key = accountKey(account);
        const { byKey, latestLedger, endpoint } = await readEntries([key]);
        const e = byKey.get(key);
        if (!e) return missing(latestLedger, endpoint, 'account entry');
        const a = decodeAccount(e.xdr);
        const r = computeReserves({
          balance: a.balance,
          subentryCount: a.numSubEntries,
          numSponsoring: a.numSponsoring,
          numSponsored: a.numSponsored,
          sellingLiabilities: a.sellingLiabilities,
          buyingLiabilities: a.buyingLiabilities,
          baseReserveStroops: h.reserves.baseReserveStroops,
        });
        const checks = [
          check('balance', fromStroops(h.stroops), fromStroops(a.balance)),
          check('subentries', String(h.reserves.subentryCount), String(a.numSubEntries)),
          check('sponsoring / sponsored', `${h.reserves.numSponsoring} / ${h.reserves.numSponsored}`, `${a.numSponsoring} / ${a.numSponsored}`),
          check('selling liabilities', fromStroops(h.reserves.sellingLiabilities), fromStroops(a.sellingLiabilities)),
          check('reserved', fromStroops(h.reserves.reserved), fromStroops(r.reserved)),
        ];
        return outcome(checks, e.lastModifiedLedgerSeq, h.lastModifiedLedger, latestLedger, endpoint, 'XLM balance and reserves');
      }
      case 'credit': {
        const key = trustlineKey(account, h.assetId);
        const { byKey, latestLedger, endpoint } = await readEntries([key]);
        const e = byKey.get(key);
        if (!e) return missing(latestLedger, endpoint, 'trustline');
        const t = decodeTrustline(e.xdr);
        const checks = [
          check('balance', fromStroops(h.stroops), fromStroops(t.balance)),
          check('authorized', String(h.flags.authorized), String((t.flags & TRUSTLINE_FLAGS.AUTHORIZED) !== 0)),
          check('clawback enabled', String(h.flags.clawbackEnabled), String((t.flags & TRUSTLINE_FLAGS.CLAWBACK_ENABLED) !== 0)),
          check('limit', h.limit, fromStroops(t.limit)),
        ];
        return outcome(checks, e.lastModifiedLedgerSeq, h.lastModifiedLedger, latestLedger, endpoint, `${h.code} trustline`);
      }
      case 'pool_share': {
        const tlKey = poolShareTrustlineKey(account, h.poolId);
        const poolKey = liquidityPoolKey(h.poolId);
        const { byKey, latestLedger, endpoint } = await readEntries([tlKey, poolKey]);
        const tl = byKey.get(tlKey);
        if (!tl) return missing(latestLedger, endpoint, 'pool share trustline');
        const t = decodeTrustline(tl.xdr);
        const checks = [check('shares', fromStroops(h.stroops), fromStroops(t.balance))];
        const pe = byKey.get(poolKey);
        if (pe && h.pool) {
          const p = decodeLiquidityPool(pe.xdr);
          checks.push(check('pool total shares', h.pool.totalShares, fromStroops(p.totalPoolShares)));
          // Reserves A and B follow the canonical asset order, as Horizon lists them.
          if (h.pool.reserves.length === 2) {
            checks.push(check(`pool reserve ${h.pool.reserves[0].code}`, h.pool.reserves[0].poolAmount, fromStroops(p.reserveA)));
            checks.push(check(`pool reserve ${h.pool.reserves[1].code}`, h.pool.reserves[1].poolAmount, fromStroops(p.reserveB)));
          }
          const res = outcome(checks, Math.max(tl.lastModifiedLedgerSeq, pe.lastModifiedLedgerSeq), Math.max(h.lastModifiedLedger ?? 0, h.pool.lastModifiedLedger), latestLedger, endpoint, 'pool share and pool reserves');
          return res;
        }
        return outcome(checks, tl.lastModifiedLedgerSeq, h.lastModifiedLedger, latestLedger, endpoint, 'pool share trustline');
      }
      case 'sep41': {
        const r = await readSep41(h.contractId, account);
        const checks = [check('balance()', h.amount, fromStroops(r.balance, r.decimals))];
        const equal = checks[0].equal;
        return {
          status: equal ? 'match' : 'changed',
          ledger: r.latestLedger,
          entryLastModified: null,
          shownLastModified: h.checkedAtLedger,
          checks,
          endpoint: null,
          message: equal
            ? `Matches ledger state #${r.latestLedger.toLocaleString('en-US')} (balance() simulation)`
            : `Newer ledger state: balance() now returns ${checks[0].ledger} at ledger #${r.latestLedger.toLocaleString('en-US')} (shown: ${h.amount} at #${h.checkedAtLedger.toLocaleString('en-US')})`,
        };
      }
    }
  } catch (err) {
    return {
      status: 'error',
      ledger: null,
      entryLastModified: null,
      shownLastModified: h.lastModifiedLedger,
      checks: [],
      endpoint: null,
      message: `Could not read the ledger: ${describeError(err)}`,
    };
  }
}

function missing(latestLedger: number, endpoint: string, what: string): VerifyResult {
  return {
    status: 'missing',
    ledger: latestLedger,
    entryLastModified: null,
    shownLastModified: null,
    checks: [],
    endpoint,
    message: `No ${what} on the ledger at #${latestLedger.toLocaleString('en-US')}: it was removed after this page loaded, or the data shown is wrong.`,
  };
}
