// Account activity from Horizon: payments (payment, path payments,
// create_account, account_merge, SAC transfers) and, in the operations view,
// every operation including CAP-38 pool deposits and withdrawals. A path
// payment is always ONE row carrying both its source and destination sides,
// and so is a Soroban contract call that swapped one asset for another.

import { scValToNative, xdr } from '@stellar/stellar-sdk';
import { explorer } from './config.ts';
import { fromStroops, toStroops, trimAmount } from './amount.ts';
import { getLedger, getOperationEffects, getOperations, getPayments, getRoot, nextCursor } from './horizon.ts';
import type { HorizonOperation, HorizonPage, HorizonTransaction } from './horizon.ts';
import { describeError } from './http.ts';
import { assetCode, assetId, assetIssuer, shortAddress } from './stellar.ts';
import type { AssetId } from './stellar.ts';

/** Issuance events: a payment from the asset's issuer mints, one to the issuer burns (SAC events say so directly). */
export type SupplyEvent = 'mint' | 'burn' | 'clawback';

export interface AssetAmount {
  /** "native", "CODE:ISSUER", or "pool:<id>" for pool shares. */
  asset: AssetId;
  code: string;
  issuer: string | null;
  amount: string;
  /** Set when this movement created or destroyed supply. */
  event?: SupplyEvent;
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
  /**
   * The other side: sender or recipient for payments, the contract for a
   * contract swap, and, for an operation of another kind made by another
   * account in this account's history, the account that made it.
   */
  counterparty: string | null;
  /** Amounts that left this account. */
  debit: AssetAmount[];
  /** Amounts that arrived on this account. */
  credit: AssetAmount[];
  /** Both sides of a path payment (whoever the parties are), or of a single-pair contract swap. */
  conversion: { source: AssetAmount; destination: AssetAmount; path: string[] } | null;
  /** Contract and function of an invoke_host_function call. */
  contract: { id: string | null; fn: string | null } | null;
  poolId: string | null;
  memo: Memo | null;
  /** Fee charged to the transaction, in XLM (the whole transaction, not this operation). */
  feeXlm: string | null;
  /** Account that paid that fee (the fee-bump or channel account when it is not the source). */
  feePaidBy: string | null;
  /** Muxed ids (CAP-27) of the sender and the recipient, when the operation used M addresses. */
  fromMuxedId: string | null;
  toMuxedId: string | null;
  /** One-line description for operations without amounts. */
  note: string | null;
  explorerUrl: string;
  txUrl: string;
}

export interface ActivityPage {
  rows: ActivityRow[];
  nextCursor: string | null;
  hasMore: boolean;
  /** Raw Horizon records of the page. */
  records: number;
  /** Cursor this page was requested with (null for the first page). */
  requestCursor: string | null;
  /** When the page was read, unix ms. */
  fetchedAt: number;
}

function amountOf(asset: AssetId, amount: string, event?: SupplyEvent): AssetAmount {
  const a: AssetAmount = { asset, code: assetCode(asset), issuer: assetIssuer(asset), amount: trimAmount(amount) };
  if (event) a.event = event;
  return a;
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
function contractCall(op: HorizonOperation): { id: string | null; fn: string | null } {
  try {
    const p = op.parameters ?? [];
    const addr = p[0]?.type === 'Address' ? scValToNative(xdr.ScVal.fromXDR(p[0].value, 'base64')) : null;
    const fn = p[1]?.type === 'Sym' ? scValToNative(xdr.ScVal.fromXDR(p[1].value, 'base64')) : null;
    return { id: typeof addr === 'string' ? addr : null, fn: typeof fn === 'string' ? fn : null };
  } catch {
    return { id: null, fn: null };
  }
}

function pathCodes(op: HorizonOperation): string[] {
  return (op.path ?? []).map((p) => (p.asset_type === 'native' ? 'XLM' : (p.asset_code ?? '?')));
}

/**
 * Direction of a payment between `from` and `to` as seen by `account`. When
 * both sides are the same base account but two different muxed ids, and the
 * page is for one of those muxed ids, the direction is relative to it.
 */
function sides(op: HorizonOperation, account: string, muxedId: string | null) {
  let out = op.from === account;
  let inn = op.to === account;
  const fromMuxedId = op.from_muxed_id ?? null;
  const toMuxedId = op.to_muxed_id ?? null;
  if (out && inn && muxedId !== null && fromMuxedId !== toMuxedId) {
    if (toMuxedId === muxedId) out = false;
    else if (fromMuxedId === muxedId) inn = false;
  }
  return { out, inn, fromMuxedId, toMuxedId };
}

/** True when the asset sets differ on both sides: something was given for something else. */
function isExchange(debit: readonly AssetAmount[], credit: readonly AssetAmount[]): boolean {
  if (!debit.length || !credit.length) return false;
  const d = new Set(debit.map((a) => a.asset));
  const c = new Set(credit.map((a) => a.asset));
  return [...c].some((x) => !d.has(x)) && [...d].some((x) => !c.has(x));
}

/**
 * Converts one Horizon operation into an activity row, from the point of view
 * of `account` (and of `muxedId` when an M address was entered).
 */
export function toActivityRow(op: HorizonOperation, account: string, muxedId: string | null = null): ActivityRow {
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
    feePaidBy: tx ? (tx.fee_account ?? tx.source_account) : null,
    explorerUrl: explorer.op(op.id),
    txUrl: explorer.tx(op.transaction_hash),
    poolId: null as string | null,
    conversion: null as ActivityRow['conversion'],
    contract: null as ActivityRow['contract'],
    fromMuxedId: null as string | null,
    toMuxedId: null as string | null,
    note: null as string | null,
  };

  switch (op.type) {
    case 'payment': {
      const asset = assetId(op.asset_type, op.asset_code, op.asset_issuer);
      const { out, inn, fromMuxedId, toMuxedId } = sides(op, account, muxedId);
      if (out && inn) {
        const a = amountOf(asset, op.amount ?? '0');
        return { ...base, kind: 'sent', title: 'Payment to self', direction: 'self', counterparty: account, debit: [a], credit: [a], fromMuxedId, toMuxedId };
      }
      const counterparty = (inn ? op.from : op.to) ?? null;
      const issuer = assetIssuer(asset);
      const event: SupplyEvent | undefined = issuer !== null && counterparty === issuer ? (inn ? 'mint' : 'burn') : undefined;
      const a = amountOf(asset, op.amount ?? '0', event);
      return {
        ...base,
        kind: inn ? 'received' : 'sent',
        title: event === 'mint' ? 'Minted by the issuer' : event === 'burn' ? 'Returned to the issuer' : inn ? 'Received' : 'Sent',
        direction: inn ? 'in' : 'out',
        counterparty,
        debit: inn ? [] : [a],
        credit: inn ? [a] : [],
        fromMuxedId,
        toMuxedId,
      };
    }
    case 'path_payment_strict_send':
    case 'path_payment_strict_receive': {
      const source = amountOf(
        assetId(op.source_asset_type, op.source_asset_code, op.source_asset_issuer),
        op.source_amount ?? '0',
      );
      const destination = amountOf(assetId(op.asset_type, op.asset_code, op.asset_issuer), op.amount ?? '0');
      const { out, inn, fromMuxedId, toMuxedId } = sides(op, account, muxedId);
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
        fromMuxedId,
        toMuxedId,
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
        // Filled from the operation effects by `loadPayments` / `loadOperations`.
        debit: [],
        credit: [],
        note: 'merged XLM amount not read yet (it is in the operation effects, not in the payment record)',
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
        const event = c.type === 'transfer' ? undefined : c.type;
        const a = amountOf(assetId(c.asset_type, c.asset_code, c.asset_issuer), c.amount, event);
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
      const what = call.fn ? `${call.fn}()${call.id ? ` on ${shortAddress(call.id)}` : ''}` : 'Soroban contract invocation';
      if (isExchange(debit, credit)) {
        // A contract call that took one asset and paid another (an AMM or
        // aggregator swap through Stellar Asset Contracts): one swap row.
        return {
          ...base,
          kind: 'swap',
          title: 'Swap via contract',
          direction: 'self',
          counterparty: call.id ?? counterparty,
          debit,
          credit,
          conversion: debit.length === 1 && credit.length === 1 ? { source: debit[0], destination: credit[0], path: [] } : null,
          contract: call,
          note: what,
        };
      }
      return {
        ...base,
        kind: 'contract',
        title: 'Contract call',
        direction: debit.length && credit.length ? 'self' : credit.length ? 'in' : debit.length ? 'out' : 'none',
        counterparty,
        debit,
        credit,
        contract: call,
        note: what,
      };
    }
    default:
      return {
        ...base,
        kind: 'other',
        title: humanType(op.type),
        direction: 'none',
        // In an account's operation history, some operations are made by
        // another account (a sponsored account setting its trustline, an
        // issuer changing flags): name who made them.
        counterparty: op.source_account !== account ? op.source_account : null,
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

/** At most this many account merges per page get their amount read from the operation effects. */
const MAX_MERGE_LOOKUPS = 20;

/**
 * The merged XLM amount of an account_merge is not in the payment record: it
 * is read from the operation's effects (account_debited on the merged
 * account, account_credited on the destination). A failed read says so on
 * the row, never a guessed amount.
 */
async function fillMergeAmounts(rows: ActivityRow[], account: string): Promise<ActivityRow[]> {
  let lookups = 0;
  return Promise.all(
    rows.map(async (r) => {
      if (r.kind !== 'merge_in' && r.kind !== 'merge_out') return r;
      if (++lookups > MAX_MERGE_LOOKUPS)
        return { ...r, note: `merged XLM amount not read: this preview reads at most ${MAX_MERGE_LOOKUPS} merges per page` };
      try {
        const effects = await getOperationEffects(r.id);
        const want = r.kind === 'merge_out' ? 'account_debited' : 'account_credited';
        const e = effects._embedded.records.find((x) => x.type === want && x.account === account && x.amount !== undefined);
        if (!e?.amount) return { ...r, note: `merged XLM amount not found in the operation effects (no ${want} effect)` };
        const a = amountOf('native', e.amount);
        return { ...r, debit: r.kind === 'merge_out' ? [a] : [], credit: r.kind === 'merge_in' ? [a] : [], note: null };
      } catch (err) {
        return { ...r, note: `merged XLM amount unavailable: ${describeError(err)}` };
      }
    }),
  );
}

async function toPage(
  page: HorizonPage<HorizonOperation>,
  account: string,
  limit: number,
  requestCursor: string | null,
  muxedId: string | null,
): Promise<ActivityPage> {
  const fetchedAt = Date.now();
  const recs = page._embedded.records;
  const rows = recs.filter((r) => r.transaction_successful !== false).map((r) => toActivityRow(r, account, muxedId));
  const cursor = nextCursor(page);
  return {
    rows: await fillMergeAmounts(rows, account),
    nextCursor: cursor,
    hasMore: recs.length === limit && cursor !== null,
    records: recs.length,
    requestCursor,
    fetchedAt,
  };
}

export async function loadPayments(account: string, cursor: string | null = null, limit = 50, muxedId: string | null = null): Promise<ActivityPage> {
  return toPage(await getPayments(account, cursor, limit), account, limit, cursor, muxedId);
}

export async function loadOperations(account: string, cursor: string | null = null, limit = 50, muxedId: string | null = null): Promise<ActivityPage> {
  return toPage(await getOperations(account, cursor, limit), account, limit, cursor, muxedId);
}

let historyFrom: Promise<number> | null = null;

/**
 * Earliest instant this Horizon instance serves history for (unix ms): the
 * close time of its `history_elder_ledger`. Public Horizon keeps about one
 * year; older operations are not served. Cached for the session.
 */
export function getHistoryFrom(): Promise<number> {
  if (!historyFrom) {
    historyFrom = (async () => {
      const root = await getRoot();
      const ledger = await getLedger(root.history_elder_ledger);
      const at = Date.parse(ledger.closed_at);
      if (!Number.isFinite(at)) throw new Error(`unreadable close time of ledger ${root.history_elder_ledger}`);
      return at;
    })();
    historyFrom.catch(() => {
      historyFrom = null;
    });
  }
  return historyFrom;
}
