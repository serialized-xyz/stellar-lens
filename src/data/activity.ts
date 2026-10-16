// Account activity from Horizon: payments (payment, path payments,
// create_account, account_merge, SAC transfers) and, in the operations view,
// every operation including CAP-38 pool deposits and withdrawals. A path
// payment is always ONE row carrying both its source and destination sides.

import { scValToNative, xdr } from '@stellar/stellar-sdk';
import { explorer } from './config.ts';
import { fromStroops, toStroops, trimAmount } from './amount.ts';
import { getOperations, getPayments, nextCursor } from './horizon.ts';
import type { HorizonOperation, HorizonPage, HorizonTransaction } from './horizon.ts';
import { assetCode, assetId, assetIssuer, shortAddress } from './stellar.ts';
import type { AssetId } from './stellar.ts';

export interface AssetAmount {
  /** "native", "CODE:ISSUER", or "pool:<id>" for pool shares. */
  asset: AssetId;
  code: string;
  issuer: string | null;
  amount: string;
}

export interface Memo {
  type: 'text' | 'id' | 'hash' | 'return';
  value: string;
}

export type ActivityKind =
  | 'received'
  | 'sent'
  | 'swap'
  | 'account_created'
  | 'account_funded'
  | 'merge_in'
  | 'merge_out'
  | 'pool_deposit'
  | 'pool_withdraw'
  | 'contract'
  | 'other';

export interface ActivityRow {
  id: string;
  pagingToken: string;
  /** unix ms */
  at: number;
  txHash: string;
  ledger: number | null;
  kind: ActivityKind;
  title: string;
  operationType: string;
  direction: 'in' | 'out' | 'self' | 'none';
  counterparty: string | null;
  /** Amounts that left this account. */
  debit: AssetAmount[];
  /** Amounts that arrived on this account. */
  credit: AssetAmount[];
  /** Both sides of a path payment, whoever the parties are. */
  conversion: { source: AssetAmount; destination: AssetAmount; path: string[] } | null;
  poolId: string | null;
  memo: Memo | null;
  /** Fee charged to the transaction, in XLM (the whole transaction, not this operation). */
  feeXlm: string | null;
  muxedId: string | null;
  /** One-line description for operations without amounts. */
  note: string | null;
  explorerUrl: string;
  txUrl: string;
}

export interface ActivityPage {
  rows: ActivityRow[];
  nextCursor: string | null;
  hasMore: boolean;
  /** Raw Horizon records of the page (used by the API mirror). */
  records: number;
}

function amountOf(asset: AssetId, amount: string): AssetAmount {
  return { asset, code: assetCode(asset), issuer: assetIssuer(asset), amount: trimAmount(amount) };
}

function poolShareAmount(poolId: string, amount: string): AssetAmount {
  return { asset: `pool:${poolId}`, code: 'Pool share', issuer: null, amount: trimAmount(amount) };
}

function memoOf(tx: HorizonTransaction | undefined): Memo | null {
  if (!tx || tx.memo_type === 'none' || tx.memo === undefined) return null;
  if (tx.memo_type === 'hash' || tx.memo_type === 'return') return { type: tx.memo_type, value: base64ToHex(tx.memo) };
  return { type: tx.memo_type, value: tx.memo };
}

function base64ToHex(b64: string): string {
  try {
    const bin = atob(b64);
    let hex = '';
    for (let i = 0; i < bin.length; i++) hex += bin.charCodeAt(i).toString(16).padStart(2, '0');
    return hex;
  } catch {
    return b64;
  }
}

/** Contract and function of an invoke_host_function call, decoded from its parameters. */
function contractCall(op: HorizonOperation): { contract: string | null; fn: string | null } {
  try {
    const p = op.parameters ?? [];
    const addr = p[0]?.type === 'Address' ? scValToNative(xdr.ScVal.fromXDR(p[0].value, 'base64')) : null;
    const fn = p[1]?.type === 'Sym' ? scValToNative(xdr.ScVal.fromXDR(p[1].value, 'base64')) : null;
    return { contract: typeof addr === 'string' ? addr : null, fn: typeof fn === 'string' ? fn : null };
  } catch {
    return { contract: null, fn: null };
  }
}

function pathCodes(op: HorizonOperation): string[] {
  return (op.path ?? []).map((p) => (p.asset_type === 'native' ? 'XLM' : (p.asset_code ?? '?')));
}

/** Converts one Horizon operation into an activity row, from the point of view of `account`. */
export function toActivityRow(op: HorizonOperation, account: string): ActivityRow {
  const tx = op.transaction;
  const base = {
    id: op.id,
    pagingToken: op.paging_token,
    at: Date.parse(op.created_at),
    txHash: op.transaction_hash,
    ledger: tx?.ledger ?? null,
    operationType: op.type,
    memo: memoOf(tx),
    feeXlm: tx ? fromStroops(BigInt(tx.fee_charged)) : null,
    explorerUrl: explorer.op(op.id),
    txUrl: explorer.tx(op.transaction_hash),
    poolId: null as string | null,
    conversion: null as ActivityRow['conversion'],
    muxedId: null as string | null,
    note: null as string | null,
  };

  switch (op.type) {
    case 'payment': {
      const a = amountOf(assetId(op.asset_type, op.asset_code, op.asset_issuer), op.amount ?? '0');
      const out = op.from === account;
      const inn = op.to === account;
      const muxedId = (inn ? op.to_muxed_id : op.from_muxed_id) ?? null;
      if (out && inn)
        return { ...base, kind: 'sent', title: 'Payment to self', direction: 'self', counterparty: account, debit: [a], credit: [a], muxedId };
      return {
        ...base,
        kind: inn ? 'received' : 'sent',
        title: inn ? 'Received' : 'Sent',
        direction: inn ? 'in' : 'out',
        counterparty: (inn ? op.from : op.to) ?? null,
        debit: inn ? [] : [a],
        credit: inn ? [a] : [],
        muxedId,
      };
    }
    case 'path_payment_strict_send':
    case 'path_payment_strict_receive': {
      const source = amountOf(
        assetId(op.source_asset_type, op.source_asset_code, op.source_asset_issuer),
        op.source_amount ?? '0',
      );
      const destination = amountOf(assetId(op.asset_type, op.asset_code, op.asset_issuer), op.amount ?? '0');
      const out = op.from === account;
      const inn = op.to === account;
      const direction = out && inn ? 'self' : inn ? 'in' : 'out';
      return {
        ...base,
        kind: 'swap',
        title: direction === 'self' ? 'Swap' : direction === 'in' ? 'Received via swap' : 'Sent via swap',
        direction,
        counterparty: direction === 'self' ? null : ((inn ? op.from : op.to) ?? null),
        debit: out ? [source] : [],
        credit: inn ? [destination] : [],
        conversion: { source, destination, path: pathCodes(op) },
        muxedId: (inn ? op.to_muxed_id : op.from_muxed_id) ?? null,
      };
    }
    case 'create_account': {
      const a = amountOf('native', op.starting_balance ?? '0');
      const created = op.account === account;
      return {
        ...base,
        kind: created ? 'account_created' : 'account_funded',
        title: created ? 'Account created' : 'Created an account',
        direction: created ? 'in' : 'out',
        counterparty: (created ? op.funder : op.account) ?? null,
        debit: created ? [] : [a],
        credit: created ? [a] : [],
      };
    }
    case 'account_merge': {
      const merged = op.source_account === account;
      return {
        ...base,
        kind: merged ? 'merge_out' : 'merge_in',
        title: merged ? 'Merged into another account' : 'Account merged into this one',
        direction: merged ? 'out' : 'in',
        counterparty: (merged ? op.into : op.source_account) ?? null,
        debit: [],
        credit: [],
        note: 'The merged XLM amount is not part of the payments record; see the operation effects.',
      };
    }
    case 'liquidity_pool_deposit': {
      const poolId = op.liquidity_pool_id ?? '';
      return {
        ...base,
        kind: 'pool_deposit',
        title: 'Pool deposit',
        direction: 'out',
        counterparty: null,
        poolId,
        debit: (op.reserves_deposited ?? []).map((r) => amountOf(r.asset, r.amount)),
        credit: op.shares_received ? [poolShareAmount(poolId, op.shares_received)] : [],
      };
    }
    case 'liquidity_pool_withdraw': {
      const poolId = op.liquidity_pool_id ?? '';
      return {
        ...base,
        kind: 'pool_withdraw',
        title: 'Pool withdrawal',
        direction: 'in',
        counterparty: null,
        poolId,
        debit: op.shares ? [poolShareAmount(poolId, op.shares)] : [],
        credit: (op.reserves_received ?? []).map((r) => amountOf(r.asset, r.amount)),
      };
    }
    case 'invoke_host_function': {
      const debit: AssetAmount[] = [];
      const credit: AssetAmount[] = [];
      let counterparty: string | null = null;
      for (const c of op.asset_balance_changes ?? []) {
        const a = amountOf(assetId(c.asset_type, c.asset_code, c.asset_issuer), c.amount);
        if (c.from === account) {
          debit.push(a);
          counterparty ??= c.to ?? null;
        }
        if (c.to === account) {
          credit.push(a);
          counterparty ??= c.from ?? null;
        }
      }
      const call = contractCall(op);
      const what = call.fn ? `${call.fn}()${call.contract ? ` on ${shortAddress(call.contract)}` : ''}` : 'Soroban contract invocation';
      return {
        ...base,
        kind: 'contract',
        title: 'Contract call',
        direction: debit.length && credit.length ? 'self' : credit.length ? 'in' : debit.length ? 'out' : 'none',
        counterparty,
        debit,
        credit,
        note: what,
      };
    }
    default:
      return {
        ...base,
        kind: 'other',
        title: humanType(op.type),
        direction: 'none',
        counterparty: null,
        debit: [],
        credit: [],
        note: describeOther(op),
      };
  }
}

const TYPE_LABELS: Record<string, string> = {
  change_trust: 'Trustline change',
  manage_sell_offer: 'Sell offer',
  manage_buy_offer: 'Buy offer',
  create_passive_sell_offer: 'Passive offer',
  set_options: 'Account options',
  allow_trust: 'Trust authorization',
  set_trust_line_flags: 'Trustline flags',
  manage_data: 'Data entry',
  bump_sequence: 'Bump sequence',
  create_claimable_balance: 'Claimable balance created',
  claim_claimable_balance: 'Claimable balance claimed',
  begin_sponsoring_future_reserves: 'Begin sponsoring',
  end_sponsoring_future_reserves: 'End sponsoring',
  revoke_sponsorship: 'Sponsorship revoked',
  clawback: 'Clawback',
  clawback_claimable_balance: 'Claimable balance clawback',
  extend_footprint_ttl: 'Extend contract TTL',
  restore_footprint: 'Restore contract state',
  inflation: 'Inflation',
};

function humanType(t: string): string {
  return TYPE_LABELS[t] ?? t.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

function describeOther(op: HorizonOperation): string | null {
  if (op.type === 'change_trust') {
    const code = op.asset_type === 'liquidity_pool_shares' ? 'pool share' : (op.asset_code ?? '?');
    const removed = op.limit !== undefined && toStroops(op.limit) === 0n;
    return `${removed ? 'Removed' : 'Set'} trustline ${code}${op.asset_issuer ? ` (${shortAddress(op.asset_issuer)})` : ''}`;
  }
  if (op.type === 'manage_sell_offer' || op.type === 'manage_buy_offer' || op.type === 'create_passive_sell_offer') {
    const sell = op.selling_asset_type === 'native' ? 'XLM' : (op.selling_asset_code ?? '?');
    const buy = op.buying_asset_type === 'native' ? 'XLM' : (op.buying_asset_code ?? '?');
    return `${op.amount ? trimAmount(op.amount) : ''} ${sell} for ${buy}${op.price ? ` at ${op.price}` : ''}`.trim();
  }
  return null;
}

function toPage(page: HorizonPage<HorizonOperation>, account: string, limit: number): ActivityPage {
  const recs = page._embedded.records;
  const rows = recs.filter((r) => r.transaction_successful !== false).map((r) => toActivityRow(r, account));
  const cursor = nextCursor(page);
  return { rows, nextCursor: cursor, hasMore: recs.length === limit && cursor !== null, records: recs.length };
}

export async function loadPayments(account: string, cursor: string | null = null, limit = 50): Promise<ActivityPage> {
  return toPage(await getPayments(account, cursor, limit), account, limit);
}

export async function loadOperations(account: string, cursor: string | null = null, limit = 50): Promise<ActivityPage> {
  return toPage(await getOperations(account, cursor, limit), account, limit);
}
