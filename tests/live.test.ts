// Live test against Stellar mainnet (public Horizon and Stellar RPC).
// Run: node tests/live.test.ts   (Node 24, built-in type stripping)
//
// For the demo account and two other well-known accounts, plus one CAP-38
// liquidity provider picked at run time from Horizon's pool participants:
//   (a) the positions JSON matches the mirrored /v1/wallet/positions schema
//   (b) every trustline balance and the XLM balance equal getLedgerEntries
//   (c) the reserves math holds against the ledger entry
//   (d) every path payment renders as exactly one swap row
// Plus: muxed address parsing and muxed directions, SEP-41 registry ids,
// price sanity, Verify (match / changed / behind / mismatch), Soroban
// contract swaps and account merges found at run time on the network, the
// history floor of Horizon, and the home-domain guard.

import { MuxedAccount, Account } from '@stellar/stellar-sdk';
import { DEMO_ACCOUNT, SEP41_REGISTRY, USDC_ID } from '../src/data/config.ts';
import { fromStroops, toStroops } from '../src/data/amount.ts';
import { getPayments, findLiquidityPools, getNetworkPayments, getOperationEffects, getPoolParticipants, nextCursor } from '../src/data/horizon.ts';
import type { HorizonOperation } from '../src/data/horizon.ts';
import { describeError, invalidate } from '../src/data/http.ts';
import { loadPositions } from '../src/data/positions.ts';
import type { CreditHolding, PositionsModel } from '../src/data/positions.ts';
import { getHistoryFrom, loadPayments, toActivityRow } from '../src/data/activity.ts';
import { PREVIEW_NULL_FIELDS, positionsJson, swapsJson, transfersJson } from '../src/data/api.ts';
import type { ActivityJsonContext } from '../src/data/api.ts';
import { isFetchableHomeDomain } from '../src/data/toml.ts';
import {
  accountKey,
  decodeAccount,
  decodeTrustline,
  parseAddress,
  poolShareTrustlineKey,
  readEntries,
  readSep41,
  trustlineKey,
} from '../src/data/stellar.ts';
import { getXlmUsd } from '../src/data/prices.ts';
import { verifyHolding } from '../src/data/verify.ts';

declare const process: { exitCode?: number };

// ------------------------------------------------------------------ harness

const results: Array<{ name: string; ok: boolean; skipped?: boolean; detail: string }> = [];
class AssertionFailed extends Error {}
/** Thrown when the network offers nothing to test right now: reported as SKIP, never as a pass. */
class Skip extends Error {}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new AssertionFailed(msg);
}

async function test(name: string, fn: () => Promise<string | void>) {
  const t0 = Date.now();
  try {
    const detail = (await fn()) ?? '';
    results.push({ name, ok: true, detail: `${detail} (${Date.now() - t0} ms)` });
    console.log(`  PASS  ${name}${detail ? `  ${detail}` : ''}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (err instanceof Skip) {
      results.push({ name, ok: true, skipped: true, detail: msg });
      console.log(`  SKIP  ${name}\n        ${msg}`);
      return;
    }
    results.push({ name, ok: false, detail: msg });
    console.log(`  FAIL  ${name}\n        ${msg}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const short = (a: string) => `${a.slice(0, 4)}...${a.slice(-4)}`;

// ------------------------------------------------------------------ accounts

const ACCOUNTS = [
  { label: `demo, ${DEMO_ACCOUNT.label}`, address: DEMO_ACCOUNT.address },
  { label: 'Circle / Centre (listed in centre.io stellar.toml)', address: 'GDEWOLMOPAVRTGNJVWOE6U6LHZVAWIJZVWM6PDLCFTUTJJEKSU32TO5W' },
  { label: 'Decaf (stellar.expert directory, decaf.so, custodian)', address: 'GC3XQ7GM6XO36MORCS2SRHHEC2G52FMO4FHPLKUG76EKMTF73ZRH4HWR' },
];

// Field lists copied from the Serialized API reference (docs.serialized.xyz,
// /endpoints/wallet-positions, wallet-transfers, wallet-swaps response examples).
const POSITION_FIELDS = [
  'key', 'chain', 'address', 'symbol', 'name', 'iconUrl', 'kind', 'decimals', 'amount', 'amountUsd',
  'entryPriceUsd', 'entryPriceLifetimeUsd', 'currentPriceUsd', 'marketCapUsd', 'exitPriceUsd',
  'realizedPnlUsd', 'unrealizedPnlUsd', 'totalPnlUsd', 'boughtTokens', 'soldTokens', 'boughtUsd', 'soldUsd',
  'buys', 'sells', 'firstTradeAt', 'lastTradeAt', 'holdingSince', 'buyFeesUsd', 'sellFeesUsd', 'totalFeesUsd',
  'labels', 'share',
];
const SUMMARY_FIELDS = ['totalValueUsd', 'realizedPnlUsd', 'unrealizedPnlUsd', 'totalPnlUsd', 'positions', 'valued'];
const TRANSFER_FIELDS = ['at', 'chain', 'txHash', 'direction', 'tokenAddress', 'tokenSymbol', 'amount', 'amountUsd', 'counterparty'];
const SWAP_FIELDS = ['id', 'at', 'chain', 'txHash', 'block', 'sent', 'received', 'volumeNative', 'volumeUsd', 'feesNative', 'route'];

const DECIMAL = /^-?\d+(\.\d+)?$/;
const isNum = (v: unknown) => typeof v === 'number' && Number.isFinite(v);

/**
 * Types of a /v1/wallet/positions row on the server (WalletPosition in
 * serialized-data). 'n' number, 's' string, 'a' string array; a trailing '?'
 * allows null.
 */
const POSITION_TYPES: Record<string, string> = {
  key: 's', chain: 's', address: 's', symbol: 's?', name: 's?', iconUrl: 's?', kind: 's', decimals: 'n?', amount: 's', amountUsd: 'n?',
  entryPriceUsd: 'n?', entryPriceLifetimeUsd: 'n?', currentPriceUsd: 'n?', marketCapUsd: 'n?', exitPriceUsd: 'n?',
  realizedPnlUsd: 'n', unrealizedPnlUsd: 'n?', totalPnlUsd: 'n', boughtTokens: 's', soldTokens: 's', boughtUsd: 'n', soldUsd: 'n',
  buys: 'n', sells: 'n', firstTradeAt: 'n?', lastTradeAt: 'n?', holdingSince: 'n?', buyFeesUsd: 'n?', sellFeesUsd: 'n?', totalFeesUsd: 'n?',
  labels: 'a', share: 'n?',
};
/** Agreed preview nullability (option A): trade-derived fields are null on position rows, and only there. */
const PREVIEW_NULLABLE = new Set<string>(PREVIEW_NULL_FIELDS);

function typeOk(v: unknown, t: string): boolean {
  if (v === null) return t.endsWith('?');
  const base = t.replace('?', '');
  if (base === 'n') return isNum(v);
  if (base === 's') return typeof v === 'string';
  if (base === 'a') return Array.isArray(v) && v.every((x) => typeof x === 'string');
  return false;
}

function checkPositionsSchema(json: ReturnType<typeof positionsJson>, account: string): string {
  assert(Array.isArray(json.data), 'data is not an array');
  const keys = new Set<string>();
  let shareSum = 0;
  for (const raw of json.data) {
    const row = raw as Record<string, unknown>;
    const fields = Object.keys(row);
    assert(
      JSON.stringify(fields) === JSON.stringify([...POSITION_FIELDS, 'stellar']),
      `row ${String(row.key)} fields differ from the API: ${fields.join(',')}`,
    );
    assert(typeof row.key === 'string' && row.key.startsWith('stellar:'), `bad key ${String(row.key)}`);
    assert(!keys.has(row.key as string), `duplicate key ${String(row.key)}`);
    keys.add(row.key as string);
    assert(row.chain === 'stellar', `chain is ${String(row.chain)}`);
    assert(typeof row.address === 'string' && row.address.length > 0, 'empty address');
    assert(['native', 'stable', 'position'].includes(row.kind as string), `kind ${String(row.kind)}`);
    assert(Number.isInteger(row.decimals), 'decimals not an integer');
    assert(typeof row.amount === 'string' && DECIMAL.test(row.amount), `amount ${String(row.amount)} is not a decimal string`);
    assert(Number(row.amount) > 0, `zero-balance row ${String(row.key)} listed`);
    for (const f of POSITION_FIELDS) {
      const v = row[f];
      const previewNull = v === null && row.kind === 'position' && PREVIEW_NULLABLE.has(f);
      assert(previewNull || typeOk(v, POSITION_TYPES[f]), `${f} on ${String(row.key)} is ${JSON.stringify(v)}, the API types it ${POSITION_TYPES[f]}`);
    }
    // USD figures are not rounded: a stable at face value is worth exactly its amount.
    if (row.kind === 'stable') assert(row.amountUsd === Number(row.amount), `stable ${String(row.key)}: amountUsd ${String(row.amountUsd)} != amount ${String(row.amount)}`);
    const st = row.stellar as Record<string, unknown>;
    assert(st && typeof st.assetType === 'string', `stellar.assetType missing on ${String(row.key)}`);
    if (row.amountUsd === null) assert(typeof st.unpricedReason === 'string' && st.unpricedReason.length > 0, `unpriced row ${String(row.key)} gives no reason`);
    else assert(typeof st.priceSource === 'string', `priced row ${String(row.key)} gives no price source`);
    if (row.kind === 'native') assert(row.address === 'native' && row.key === 'stellar:native:native', 'native row key/address');
    if (st.assetType === 'liquidity_pool_shares') {
      const tl = st.trustline as Record<string, unknown>;
      assert(!('authorized' in tl), `pool share ${String(row.key)} carries an authorized flag (CAP-38 pool-share trustlines have none)`);
    }
    if (row.kind === 'stable') assert(row.address === USDC_ID && (row.key as string).endsWith(':stable'), 'stable row is not Circle USDC');
    if (typeof row.share === 'number') shareSum += row.share;
  }
  const meta = json.meta as Record<string, unknown>;
  assert(typeof meta.asOf === 'number' && meta.asOf > 1.7e12, 'meta.asOf must be unix ms');
  assert(meta.hasMore === false, 'meta.hasMore must be false (all rows served)');
  const summary = meta.summary as Record<string, unknown>;
  assert(JSON.stringify(Object.keys(summary)) === JSON.stringify(SUMMARY_FIELDS), `summary fields ${Object.keys(summary).join(',')}`);
  assert(summary.positions === json.data.length, 'summary.positions differs from the row count');
  assert(typeof summary.totalValueUsd === 'number', 'totalValueUsd not a number');
  if ((summary.totalValueUsd as number) > 0) assert(Math.abs(shareSum - 100) < 0.05, `shares sum to ${shareSum}, expected 100`);
  assert((meta.stellar as Record<string, unknown>).account === account, 'meta.stellar.account');
  assert((meta.stellar as Record<string, unknown>).tradeHistory === 'not_indexed_in_preview', 'meta.stellar.tradeHistory must declare the preview nulls');
  return `${json.data.length} rows, ${String(summary.valued)} valued, total ${Number(summary.totalValueUsd).toLocaleString('en-US')} USD`;
}

/**
 * Compares every balance of the model with getLedgerEntries. When a value
 * differs because the entry changed between the two reads (newer
 * lastModifiedLedgerSeq on RPC), the account is re-read; any other difference
 * fails the test.
 */
async function ledgerCompare(address: string, first: PositionsModel, label: string): Promise<{ model: PositionsModel; keys: number; rounds: number }> {
  let model = first;
  for (let round = 1; round <= 4; round++) {
    const rows = [...model.holdings, ...model.emptyTrustlines];
    const keyOf = new Map<string, string>();
    for (const h of rows) {
      if (h.type === 'native') keyOf.set(h.key, accountKey(address));
      else if (h.type === 'credit') keyOf.set(h.key, trustlineKey(address, h.assetId));
      else if (h.type === 'pool_share') keyOf.set(h.key, poolShareTrustlineKey(address, h.poolId));
    }
    const { byKey, latestLedger } = await readEntries([...new Set(keyOf.values())]);
    const diffs: string[] = [];
    let raced = false;
    for (const h of rows) {
      const k = keyOf.get(h.key);
      if (!k) continue;
      const e = byKey.get(k);
      if (!e) {
        diffs.push(`${h.code}: entry missing at ledger ${latestLedger}`);
        raced = true;
        continue;
      }
      const ledgerBal = h.type === 'native' ? decodeAccount(e.xdr).balance : decodeTrustline(e.xdr).balance;
      const shown = 'stroops' in h ? h.stroops : null;
      if (shown === null) continue;
      if (ledgerBal !== shown) {
        diffs.push(`${h.code}: Horizon ${fromStroops(shown)} (#${h.lastModifiedLedger}) vs RPC ${fromStroops(ledgerBal)} (#${e.lastModifiedLedgerSeq})`);
        if (h.lastModifiedLedger !== null && e.lastModifiedLedgerSeq !== h.lastModifiedLedger) raced = true;
      } else if (h.lastModifiedLedger !== null && e.lastModifiedLedgerSeq < h.lastModifiedLedger) {
        raced = true; // RPC behind Horizon for this entry: re-read for a clean comparison
      }
    }
    if (!diffs.length) return { model, keys: keyOf.size, rounds: round };
    if (!raced) throw new AssertionFailed(`${label}: same entry version, different value: ${diffs.join('; ')}`);
    if (round === 4) throw new AssertionFailed(`${label}: still differing after 4 reads (busy account?): ${diffs.join('; ')}`);
    await sleep(4_000);
    invalidate(address);
    model = await loadPositions({ account: address, input: address, muxedId: null }, { skipSep41: true });
  }
  throw new AssertionFailed('unreachable');
}

// ------------------------------------------------------------------ run

console.log('Stellar Lens live test (mainnet)\n');

const models = new Map<string, PositionsModel>();

await test('XLM/USD price passes its guards (order book mid, cross-checked with the classic pool)', async () => {
  const p = await getXlmUsd();
  assert(p.ok, `XLM unpriced: ${p.ok ? '' : p.reason}`);
  return `${p.price.usd.toFixed(5)} USD; ${p.price.detail}`;
});

await test('muxed address M... resolves to its base G account and id', async () => {
  const m = new MuxedAccount(new Account(DEMO_ACCOUNT.address, '0'), '1234567890123').accountId();
  const parsed = parseAddress(m);
  assert(parsed.ok, `parse failed: ${parsed.ok ? '' : parsed.error}`);
  assert(parsed.value.account === DEMO_ACCOUNT.address, 'wrong base account');
  assert(parsed.value.muxedId === '1234567890123', `wrong muxed id ${parsed.value.muxedId}`);
  const bad = parseAddress('GBADADDRESS');
  assert(!bad.ok, 'invalid address accepted');
  return `${m.slice(0, 8)}... -> ${short(parsed.value.account)} id ${parsed.value.muxedId}`;
});

for (const acc of ACCOUNTS) {
  await test(`(a) positions JSON matches the API schema: ${acc.label}`, async () => {
    const parsed = parseAddress(acc.address);
    assert(parsed.ok, 'address');
    const model = await loadPositions(parsed.value, { skipSep41: acc.address !== DEMO_ACCOUNT.address });
    models.set(acc.address, model);
    assert(model.complete, 'model incomplete');
    assert(model.summary.pending === 0, 'valuations still pending');
    return checkPositionsSchema(positionsJson(model), acc.address);
  });

  await test(`(b) every balance equals getLedgerEntries: ${acc.label}`, async () => {
    const model = models.get(acc.address);
    assert(model, 'no model (previous test failed)');
    const { model: fresh, keys, rounds } = await ledgerCompare(acc.address, model, acc.label);
    models.set(acc.address, fresh);
    return `${keys} entries (account + ${keys - 1} trustlines) equal at RPC${rounds > 1 ? `, after ${rounds} reads (account active during the test)` : ''}`;
  });

  await test(`(c) reserves math against the ledger entry: ${acc.label}`, async () => {
    const model = models.get(acc.address);
    assert(model, 'no model');
    const native = model.holdings.find((h) => h.type === 'native');
    assert(native && native.type === 'native', 'no XLM row');
    const { byKey } = await readEntries([accountKey(acc.address)]);
    const e = byKey.get(accountKey(acc.address));
    assert(e, 'account entry missing');
    const a = decodeAccount(e.xdr);
    const base = BigInt(model.ledger.base_reserve_in_stroops);
    assert(base === 5_000_000n, `base reserve is ${base} stroops (expected 0.5 XLM on mainnet)`);
    const r = native.reserves;
    const expectedMin = BigInt(2 + a.numSubEntries + a.numSponsoring - a.numSponsored) * base;
    assert(r.subentryCount === a.numSubEntries, `subentries ${r.subentryCount} vs ledger ${a.numSubEntries}`);
    assert(r.numSponsoring === a.numSponsoring && r.numSponsored === a.numSponsored, 'sponsorship counters differ');
    assert(r.minimumBalance === expectedMin, `minimum balance ${fromStroops(r.minimumBalance)} vs ${fromStroops(expectedMin)}`);
    assert(r.sellingLiabilities === a.sellingLiabilities, 'selling liabilities differ');
    assert(r.reserved === expectedMin + a.sellingLiabilities, 'reserved != minimum + selling liabilities');
    assert(r.spendable === (r.total > r.reserved ? r.total - r.reserved : 0n), 'spendable != total - reserved');
    // Each trustline is one subentry, a pool-share trustline two (CAP-38).
    const tl = [...model.holdings, ...model.emptyTrustlines].reduce((n, h) => n + (h.type === 'credit' ? 1 : h.type === 'pool_share' ? 2 : 0), 0);
    assert(a.numSubEntries >= tl, `numSubEntries ${a.numSubEntries} < trustline subentries ${tl}`);
    return `min ${fromStroops(r.minimumBalance)} = (2 + ${a.numSubEntries} + ${a.numSponsoring} - ${a.numSponsored}) x 0.5; reserved ${fromStroops(r.reserved)}; spendable ${fromStroops(r.spendable)} XLM`;
  });

  await test(`(d) path payments render as one swap row each: ${acc.label}`, async () => {
    const page = await getPayments(acc.address, null, 50);
    const recs = page._embedded.records;
    const rows = recs.map((r) => toActivityRow(r, acc.address));
    assert(rows.length === recs.length, 'one row per operation');
    const paths = recs.filter((r) => r.type.startsWith('path_payment'));
    for (const rec of paths) {
      const matching = rows.filter((r) => r.id === rec.id);
      assert(matching.length === 1, `operation ${rec.id} produced ${matching.length} rows`);
      const row = matching[0];
      assert(row.kind === 'swap' && row.conversion, `path payment ${rec.id} is not a swap row`);
      assert(row.conversion.source.amount === fromStroops(toStroops(rec.source_amount ?? '')), 'source amount differs');
      assert(row.conversion.destination.amount === fromStroops(toStroops(rec.amount ?? '')), 'destination amount differs');
      const srcCode = rec.source_asset_type === 'native' ? 'XLM' : rec.source_asset_code;
      const dstCode = rec.asset_type === 'native' ? 'XLM' : rec.asset_code;
      assert(row.conversion.source.code === srcCode && row.conversion.destination.code === dstCode, 'asset codes differ');
    }
    // The API mirrors stay well-formed on this page.
    const pageInfo = { hasMore: true, nextCursor: 'x' };
    const ctx: ActivityJsonContext = { wallet: acc.address, muxedId: null, asOf: Date.now(), historyFrom: null };
    const transfers = transfersJson(rows, pageInfo, ctx);
    for (const t of transfers.data as Array<Record<string, unknown>>) {
      assert(JSON.stringify(Object.keys(t)) === JSON.stringify([...TRANSFER_FIELDS, 'stellar']), `transfer fields ${Object.keys(t).join(',')}`);
      assert(t.direction === 'in' || t.direction === 'out', 'direction');
      assert(typeof t.amount === 'string' && DECIMAL.test(t.amount), 'transfer amount');
    }
    const swaps = swapsJson(rows, pageInfo, ctx);
    for (const s of swaps.data as Array<Record<string, unknown>>) {
      assert(JSON.stringify(Object.keys(s)) === JSON.stringify([...SWAP_FIELDS, 'stellar']), `swap fields ${Object.keys(s).join(',')}`);
      assert(Array.isArray(s.route), 'route must be an array (the API types it SwapLeg[])');
      assert(typeof s.block === 'number', 'block must be a number');
    }
    if (!paths.length) return `no path payment in the last ${recs.length} payments (nothing to check); ${transfers.data.length} transfer rows well-formed`;
    const sample = rows.find((r) => r.operationType.startsWith('path_payment'))!;
    return `${paths.length}/${recs.length} payments are path payments, each one row (e.g. ${sample.conversion!.source.amount} ${sample.conversion!.source.code} > ${sample.conversion!.destination.amount} ${sample.conversion!.destination.code}); ${transfers.data.length} transfer rows, ${swaps.data.length} swap rows`;
  });
}

const offlineTx = (me: string, feeAccount?: string) => ({
  hash: 'ab'.repeat(32), ledger: 1, created_at: '2026-10-16T10:00:00Z', memo_type: 'text' as const, memo: 'x', fee_charged: '200',
  successful: true, operation_count: 2, source_account: me, ...(feeAccount ? { fee_account: feeAccount } : {}),
});
const USDC_ISSUER_ID = USDC_ID.split(':')[1];

await test('swaps mirror: two self path payments in one transaction make one /v1/wallet/swaps row, netted (offline)', async () => {
  const me = DEMO_ACCOUNT.address;
  const tx = offlineTx(me);
  const leg = (id: string, src: string, dst: string) => ({
    id, paging_token: id, transaction_successful: true, source_account: me, type: 'path_payment_strict_send', created_at: tx.created_at,
    transaction_hash: tx.hash, transaction: tx, from: me, to: me,
    source_asset_type: 'native', source_amount: src,
    asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: USDC_ISSUER_ID, amount: dst, path: [],
  });
  const rows = [toActivityRow(leg('1', '100.0000000', '18.5000000'), me), toActivityRow(leg('2', '50.0000000', '9.2500000'), me)];
  assert(rows.every((r) => r.kind === 'swap' && r.direction === 'self'), 'self path payments must be swap rows');
  const ctx: ActivityJsonContext = { wallet: me, muxedId: null, asOf: Date.now(), historyFrom: null };
  const swaps = swapsJson(rows, { hasMore: false, nextCursor: null }, ctx);
  assert(swaps.data.length === 1, `expected one swap row per transaction, got ${swaps.data.length}`);
  const s = swaps.data[0] as { sent: Array<{ amount: number }>; received: Array<{ amount: number }>; feesNative: number; volumeUsd: number };
  assert(s.sent[0].amount === 150 && s.received[0].amount === 27.75, `netted amounts wrong: ${JSON.stringify(s)}`);
  assert(s.feesNative === 0.00002, `fee ${s.feesNative} (the wallet paid it)`);
  assert(s.volumeUsd === 27.75, `volumeUsd ${s.volumeUsd} (USDC side, unrounded)`);
  const transfers = transfersJson(rows, { hasMore: false, nextCursor: null }, ctx);
  assert(transfers.data.length === 0, 'an own swap is not a transfer');
  // Same swap, fee paid by a channel account: the wallet paid nothing.
  const channel = 'GDEWOLMOPAVRTGNJVWOE6U6LHZVAWIJZVWM6PDLCFTUTJJEKSU32TO5W';
  const tx2 = offlineTx(me, channel);
  const viaChannel = toActivityRow({ ...leg('3', '100.0000000', '18.5000000'), transaction: tx2 }, me);
  const s2 = swapsJson([viaChannel], { hasMore: false, nextCursor: null }, ctx).data[0] as { feesNative: number; stellar: { feePaidBy: string } };
  assert(s2.feesNative === 0 && s2.stellar.feePaidBy === channel, `fee paid by another account must be 0 for the wallet, got ${s2.feesNative}`);
  return '150 XLM > 27.75 USDC in one row, fee 0.00002 XLM (0 when a channel account pays it), no transfer rows';
});

await test('swaps mirror: an asset that only passes through a transaction cancels out (offline)', async () => {
  const me = DEMO_ACCOUNT.address;
  const tx = offlineTx(me);
  const eurc = 'EURC:GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2';
  const op = (id: string, srcType: string, srcCode: string | undefined, srcIssuer: string | undefined, src: string, dstType: string, dstCode: string | undefined, dstIssuer: string | undefined, dst: string) => ({
    id, paging_token: id, transaction_successful: true, source_account: me, type: 'path_payment_strict_send', created_at: tx.created_at,
    transaction_hash: tx.hash, transaction: tx, from: me, to: me,
    source_asset_type: srcType, source_asset_code: srcCode, source_asset_issuer: srcIssuer, source_amount: src,
    asset_type: dstType, asset_code: dstCode, asset_issuer: dstIssuer, amount: dst, path: [],
  });
  // XLM > USDC, then USDC > EURC in the same transaction: XLM sent, EURC received, USDC nets out.
  const rows = [
    toActivityRow(op('1', 'native', undefined, undefined, '100.0000000', 'credit_alphanum4', 'USDC', USDC_ISSUER_ID, '18.5000000'), me),
    toActivityRow(op('2', 'credit_alphanum4', 'USDC', USDC_ISSUER_ID, '18.5000000', 'credit_alphanum4', 'EURC', eurc.split(':')[1], '16.0000000'), me),
  ];
  const s = swapsJson(rows, { hasMore: false, nextCursor: null }, { wallet: me, muxedId: null, asOf: Date.now(), historyFrom: null }).data[0] as {
    sent: Array<{ tokenAddress: string; amount: number }>;
    received: Array<{ tokenAddress: string; amount: number }>;
  };
  assert(s.sent.length === 1 && s.sent[0].tokenAddress === 'native' && s.sent[0].amount === 100, `sent ${JSON.stringify(s.sent)}`);
  assert(s.received.length === 1 && s.received[0].tokenAddress === eurc && s.received[0].amount === 16, `received ${JSON.stringify(s.received)}`);
  return '100 XLM sent, 16 EURC received, USDC cancelled out';
});

await test('muxed: a payment between two muxed ids of one account reads in or out relative to the M address entered (offline)', async () => {
  const me = DEMO_ACCOUNT.address;
  const tx = offlineTx(me);
  const op = {
    id: '9', paging_token: '9', transaction_successful: true, source_account: me, type: 'payment', created_at: tx.created_at,
    transaction_hash: tx.hash, transaction: tx, from: me, from_muxed_id: '111', to: me, to_muxed_id: '222',
    asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: USDC_ISSUER_ID, amount: '5.0000000',
  };
  const asBase = toActivityRow(op, me);
  const asReceiver = toActivityRow(op, me, '222');
  const asSender = toActivityRow(op, me, '111');
  assert(asBase.direction === 'self', `base view: ${asBase.direction}`);
  assert(asReceiver.direction === 'in' && asSender.direction === 'out', `muxed views: ${asReceiver.direction} / ${asSender.direction}`);
  assert(asReceiver.fromMuxedId === '111' && asReceiver.toMuxedId === '222', 'both muxed ids kept on the row');
  const ctx = (muxedId: string | null): ActivityJsonContext => ({ wallet: me, muxedId, asOf: Date.now(), historyFrom: null });
  const page = { hasMore: false, nextCursor: null };
  assert(transfersJson([asBase], page, ctx(null)).data.length === 0, 'base view: internal movement is no transfer');
  const t = transfersJson([asReceiver], page, ctx('222')).data;
  assert(t.length === 1 && t[0].direction === 'in', 'receiver view: one inbound transfer');
  // A payment from the issuer is a mint, flagged on the transfer.
  const mint = toActivityRow({ ...op, from: USDC_ISSUER_ID, from_muxed_id: undefined, to_muxed_id: undefined }, me);
  const mt = transfersJson([mint], page, ctx(null)).data[0] as unknown as { stellar: { supplyEvent: string | null } };
  assert(mt.stellar.supplyEvent === 'mint', `payment from the issuer: supplyEvent ${String(mt.stellar.supplyEvent)}`);
  return 'base: self (no transfer); M...222: in; M...111: out; issuer payment flagged mint';
});

await test('Soroban contract swap: one swap row, in /swaps, not in /transfers (offline, shaped like a Horizon record)', async () => {
  const me = DEMO_ACCOUNT.address;
  const tx = offlineTx(me);
  const pool = 'CCPGFQUTSEHDIQODRE3GJDNE64A35HZ32L7LPDN7GXOCIYNBJSMS6V6B';
  const aqua = { asset_type: 'credit_alphanum4', asset_code: 'AQUA', asset_issuer: 'GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA' };
  const op = {
    id: '7', paging_token: '7', transaction_successful: true, source_account: me, type: 'invoke_host_function', created_at: tx.created_at,
    transaction_hash: tx.hash, transaction: tx, function: 'HostFunctionTypeHostFunctionTypeInvokeContract', parameters: [],
    asset_balance_changes: [
      { asset_type: 'native', type: 'transfer' as const, from: me, to: pool, amount: '4.0000000' },
      { asset_type: 'native', type: 'transfer' as const, from: pool, to: pool, amount: '4.0000000' },
      { ...aqua, type: 'transfer' as const, from: pool, to: pool, amount: '2295.0985461' },
      { ...aqua, type: 'transfer' as const, from: pool, to: me, amount: '2295.0985461' },
    ],
  };
  const row = toActivityRow(op, me);
  assert(row.kind === 'swap' && row.direction === 'self' && row.conversion, `row ${row.kind}/${row.direction}`);
  const ctx: ActivityJsonContext = { wallet: me, muxedId: null, asOf: Date.now(), historyFrom: null };
  const page = { hasMore: false, nextCursor: null };
  assert(transfersJson([row], page, ctx).data.length === 0, 'a contract swap adds no transfer rows');
  const sw = swapsJson([row], page, ctx).data[0] as unknown as { sent: Array<{ tokenAddress: string; amount: number }>; received: Array<{ amount: number }>; route: unknown[] };
  assert(sw.sent[0].tokenAddress === 'native' && sw.sent[0].amount === 4 && sw.received[0].amount === 2295.0985461, `swap ${JSON.stringify(sw)}`);
  assert(Array.isArray(sw.route), 'route is an array');
  // A contract call that takes and pays back the same asset is no swap: two transfers.
  const refund = toActivityRow({ ...op, asset_balance_changes: [op.asset_balance_changes[0], { ...op.asset_balance_changes[1], to: me, amount: '1.0000000' }] }, me);
  assert(refund.kind === 'contract' && transfersJson([refund], page, ctx).data.length === 2, 'same-asset round trip stays two transfers');
  return '4 XLM > 2295.0985461 AQUA in one /swaps row, no transfer; a same-asset round trip stays two transfers';
});

await test('errors: a wallet-kit rejection object reads as its message, not [object Object] (offline)', async () => {
  const msg = describeError({ code: -1, message: 'The user closed the modal.' });
  assert(msg === 'The user closed the modal.', `got "${msg}"`);
  return msg;
});

await test('home-domain guard: only public hostnames are fetched for stellar.toml, never a Serialized host (offline)', async () => {
  const ok = ['centre.io', 'www.circle.com', 'aqua.network', 'decaf.so'];
  const refused = ['localhost', 'localhost:8080', '127.0.0.1', '10.0.0.1', '[::1]', 'api.serialized.xyz', 'serialized.xyz', 'cdn.serialized.cloud', 'example.com:443', 'a', '-bad.com', 'http://x.com'];
  for (const d of ok) assert(isFetchableHomeDomain(d), `${d} should be fetchable`);
  for (const d of refused) assert(!isFetchableHomeDomain(d), `${d} should be refused`);
  return `${ok.length} accepted, ${refused.length} refused`;
});

await test('Verify button logic: every demo holding matches the ledger (or reports a newer ledger state)', async () => {
  const model = models.get(DEMO_ACCOUNT.address);
  assert(model, 'no demo model');
  const out: string[] = [];
  for (const h of model.holdings) {
    let v = await verifyHolding(h, DEMO_ACCOUNT.address);
    // An RPC node a ledger behind Horizon is a transient state: one retry.
    if (v.status === 'behind') {
      await sleep(6_000);
      v = await verifyHolding(h, DEMO_ACCOUNT.address);
    }
    assert(v.status === 'match' || v.status === 'changed', `${h.code}: ${v.status}: ${v.message}`);
    out.push(`${h.code} ${v.status}`);
  }
  return out.join(', ');
});

await test('Verify outcomes on a quiet trustline: changed, behind and mismatch are told apart', async () => {
  const model = models.get('GC3XQ7GM6XO36MORCS2SRHHEC2G52FMO4FHPLKUG76EKMTF73ZRH4HWR');
  assert(model, 'no Decaf model');
  const credits = [...model.holdings, ...model.emptyTrustlines].filter((h): h is CreditHolding => h.type === 'credit' && h.lastModifiedLedger !== null);
  // The trustline modified longest ago: least likely to change during the test.
  const quiet = credits.sort((a, b) => (a.lastModifiedLedger ?? 0) - (b.lastModifiedLedger ?? 0))[0];
  assert(quiet, 'no trustline');
  const key = trustlineKey(model.account.id, quiet.assetId);
  const { byKey } = await readEntries([key]);
  const e = byKey.get(key);
  assert(e, 'trustline entry missing');
  const wrong = { ...quiet, stroops: quiet.stroops + 1n };
  const at = (lastModifiedLedger: number) => verifyHolding({ ...wrong, lastModifiedLedger }, model.account.id);
  const same = await at(e.lastModifiedLedgerSeq);
  const older = await at(e.lastModifiedLedgerSeq - 1);
  const newer = await at(e.lastModifiedLedgerSeq + 1_000_000);
  const good = await verifyHolding(quiet, model.account.id);
  assert(same.status === 'mismatch', `same entry version, wrong value: ${same.status}`);
  assert(older.status === 'changed', `entry newer on the ledger than shown: ${older.status}`);
  assert(newer.status === 'behind', `entry older on RPC than shown: ${newer.status}`);
  assert(good.status === 'match', `untouched holding: ${good.status}: ${good.message}`);
  assert(good.checks.some((c) => c.field === 'buying liabilities') && good.checks.some((c) => c.field === 'maintain liabilities'), 'liabilities and flag 2 are compared');
  return `${quiet.code} (entry of ledger #${e.lastModifiedLedgerSeq}): mismatch / changed / behind / match, ${good.checks.length} fields compared`;
});

await test('demo prices: USDC at face value, EURC priced through a path and plausible', async () => {
  const model = models.get(DEMO_ACCOUNT.address);
  assert(model, 'no demo model');
  const usdc = model.holdings.find((h) => h.type === 'credit' && h.assetId === USDC_ID);
  assert(usdc && usdc.valuation.priceUsd === 1 && usdc.valuation.source === 'usdc_peg', 'USDC not at face value');
  const eurc = model.holdings.find((h) => h.code === 'EURC');
  assert(eurc, 'demo has no EURC row');
  if (eurc.valuation.state === 'priced') {
    const p = eurc.valuation.priceUsd ?? 0;
    assert(p > 0.8 && p < 1.6, `EURC at ${p} USD is implausible`);
    return `EURC ${p.toFixed(4)} USD (${eurc.valuation.detail}); value at depth ${eurc.valuation.depthRatio === null ? '100%' : `${(eurc.valuation.depthRatio * 100).toFixed(1)}%`} of spot`;
  }
  return `EURC unpriced, reason shown: ${eurc.valuation.reason}`;
});

await test('SEP-41 registry: every contract answers balance() and its symbol matches the registry', async () => {
  const out: string[] = [];
  for (const entry of SEP41_REGISTRY) {
    const r = await readSep41(entry.contractId, DEMO_ACCOUNT.address);
    assert(r.symbol === entry.symbol, `${entry.contractId} symbol() is ${r.symbol}, registry says ${entry.symbol}`);
    assert(r.balance >= 0n, 'negative balance');
    out.push(`${r.symbol} (${r.decimals} dec) balance ${fromStroops(r.balance, r.decimals)}`);
  }
  return out.join('; ');
});

await test('CAP-38 pool share: split into reserves, shares and reserves equal the ledger (LP picked from Horizon)', async () => {
  const pools = await findLiquidityPools(['native', USDC_ID]);
  const pool = pools._embedded.records[0];
  assert(pool, 'XLM/USDC pool not found');
  const parts = await getPoolParticipants(pool.id, 10);
  const lp = parts._embedded.records.find((a) =>
    a.balances.some((b) => b.asset_type === 'liquidity_pool_shares' && b.liquidity_pool_id === pool.id && Number(b.balance) > 0),
  );
  assert(lp, 'no participant with a positive share');
  const model = await loadPositions({ account: lp.id, input: lp.id, muxedId: null }, { skipSep41: true });
  const share = model.holdings.find((h) => h.type === 'pool_share' && h.poolId === pool.id);
  assert(share && share.type === 'pool_share' && share.pool, 'pool share row missing or not split');
  assert(share.pool.reserves.length === 2, 'expected two reserves');
  for (const r of share.pool.reserves) assert(toStroops(r.amount) <= toStroops(r.poolAmount), `${r.code} share exceeds the pool reserve`);
  let v = await verifyHolding(share, lp.id);
  if (v.status === 'behind') {
    await sleep(6_000);
    v = await verifyHolding(share, lp.id);
  }
  assert(v.status === 'match' || v.status === 'changed', `pool verify: ${v.status}: ${v.message}`);
  checkPositionsSchema(positionsJson(model), lp.id);
  // Each reserve is valued at depth, like a trustline holding; the share's price is the spot value per share.
  if (share.valuation.state === 'priced') assert(share.pool.reserves.every((r) => r.valueUsd !== null && r.priceUsd !== null), 'priced share with an unvalued reserve');
  const [a, b] = share.pool.reserves;
  return `${share.amount} shares (${share.pool.sharePercent.toPrecision(3)}% of pool) = ${a.amount} ${a.code} + ${b.amount} ${b.code}; value ${share.valuation.valueUsd?.toFixed(2) ?? 'unpriced'} USD; ledger ${v.status}`;
});

/** Scans recent network payments (at most `pages` x 200 records, one request at a time) for a record matching `pick`. */
async function findOnNetwork(pick: (op: HorizonOperation) => boolean, pages: number): Promise<{ op: HorizonOperation | null; scanned: number }> {
  let cursor: string | null = null;
  let scanned = 0;
  for (let i = 0; i < pages; i++) {
    const page = await getNetworkPayments(cursor, 200);
    scanned += page._embedded.records.length;
    const op = page._embedded.records.find((r) => r.transaction_successful !== false && pick(r));
    if (op) return { op, scanned };
    cursor = nextCursor(page);
    if (!cursor) break;
    await sleep(400);
  }
  return { op: null, scanned };
}

await test('Soroban contract swap on mainnet: contract swaps of a real account stay out of /transfers (account found at run time)', async () => {
  // A contract call whose SAC balance changes take one asset from an account and pay it another.
  const isSwapFor = (op: HorizonOperation) => {
    if (op.type !== 'invoke_host_function') return null;
    const ch = op.asset_balance_changes ?? [];
    for (const c of ch) {
      if (!c.from || !c.from.startsWith('G')) continue;
      const out = new Set(ch.filter((x) => x.from === c.from).map((x) => `${x.asset_code}:${x.asset_issuer}`));
      const inn = new Set(ch.filter((x) => x.to === c.from).map((x) => `${x.asset_code}:${x.asset_issuer}`));
      if ([...inn].some((a) => !out.has(a)) && [...out].some((a) => !inn.has(a))) return c.from;
    }
    return null;
  };
  const { op, scanned } = await findOnNetwork((r) => isSwapFor(r) !== null, 15);
  if (!op) throw new Skip(`no contract swap in the last ${scanned} network payments`);
  const account = isSwapFor(op)!;
  const row = toActivityRow(op, account);
  assert(row.kind === 'swap' && row.direction === 'self' && row.debit.length && row.credit.length, `contract swap row: ${row.kind}/${row.direction}`);
  const ctx: ActivityJsonContext = { wallet: account, muxedId: null, asOf: Date.now(), historyFrom: null };
  const page = { hasMore: false, nextCursor: null };
  assert(transfersJson([row], page, ctx).data.length === 0, 'a contract swap adds no transfer rows');
  const swaps = swapsJson([row], page, ctx).data as Array<{ sent: Array<{ amount: number }>; received: Array<{ amount: number }>; stellar: { operations: Array<{ contract: { id: string | null } | null }> } }>;
  assert(swaps.length === 1 && swaps[0].sent.length >= 1 && swaps[0].received.length >= 1, 'one swap row with both sides');
  assert(swaps[0].stellar.operations[0].contract !== null, 'swap carries the contract it called');
  // The same holds on that account's latest payments page.
  const full = await loadPayments(account, null, 50);
  const contractSwaps = full.rows.filter((r) => r.kind === 'swap' && r.operationType === 'invoke_host_function');
  const tj = transfersJson(full.rows, page, ctx).data as unknown as Array<{ stellar: { operationId: string } }>;
  const leaked = tj.filter((t) => contractSwaps.some((r) => r.id === t.stellar.operationId));
  assert(leaked.length === 0, `${leaked.length} contract-swap movements leaked into /transfers`);
  const sj = swapsJson(full.rows, page, ctx).data;
  const txs = new Set(contractSwaps.map((r) => r.txHash));
  assert([...txs].every((h) => sj.some((s) => s.txHash === h)), 'every contract-swap transaction is a /swaps row');
  return `${short(account)}: ${row.debit.map((a) => `${a.amount} ${a.code}`).join(' + ')} > ${row.credit.map((a) => `${a.amount} ${a.code}`).join(' + ')} via ${row.note}; latest page: ${contractSwaps.length} contract swaps, ${sj.length} /swaps rows, ${tj.length} transfer rows, none from a swap`;
});

await test('account merge: the merged XLM amount is read from the operation effects (merge found at run time)', async () => {
  const { op, scanned } = await findOnNetwork((r) => r.type === 'account_merge', 10);
  if (!op) throw new Skip(`no account_merge in the last ${scanned} network payments`);
  const into = op.into!;
  const effects = await getOperationEffects(op.id);
  const credited = effects._embedded.records.find((e) => e.type === 'account_credited' && e.account === into);
  assert(credited?.amount, 'no account_credited effect');
  // Reload the destination's payments until the merge is on the page (it is recent).
  const page = await loadPayments(into, null, 200);
  const row = page.rows.find((r) => r.id === op.id);
  if (!row) throw new Skip(`merge ${op.id} not on the destination's latest 200 payments (busy account)`);
  assert(row.kind === 'merge_in' && row.credit.length === 1, `merge row: ${row.kind}, ${row.credit.length} credits, note ${row.note}`);
  assert(row.credit[0].amount === fromStroops(toStroops(credited.amount)), `amount ${row.credit[0].amount} vs effect ${credited.amount}`);
  const t = transfersJson([row], { hasMore: false, nextCursor: null }, { wallet: into, muxedId: null, asOf: Date.now(), historyFrom: null }).data;
  assert(t.length === 1 && t[0].direction === 'in' && t[0].tokenAddress === 'native', 'merge appears as one inbound XLM transfer');
  return `${short(op.source_account)} merged into ${short(into)}: ${row.credit[0].amount} XLM, as in the effects`;
});

await test('history floor: meta.historyFrom is the close time of Horizon\'s oldest retained ledger', async () => {
  const from = await getHistoryFrom();
  assert(from > Date.parse('2015-01-01') && from < Date.now(), `historyFrom ${from}`);
  const j = transfersJson([], { hasMore: false, nextCursor: null }, { wallet: DEMO_ACCOUNT.address, muxedId: null, asOf: Date.now(), historyFrom: from });
  assert(j.meta.historyFrom === from && !('oldestAt' in j.meta), 'empty page: historyFrom set, no oldestAt');
  return `Horizon serves history from ${new Date(from).toISOString()}`;
});

// ------------------------------------------------------------------ summary

const failed = results.filter((r) => !r.ok);
const skipped = results.filter((r) => r.skipped);
console.log(
  `\n${results.length - failed.length - skipped.length}/${results.length} passed${skipped.length ? `, ${skipped.length} skipped` : ''}${failed.length ? `, ${failed.length} failed` : ''}`,
);
if (failed.length) {
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  process.exitCode = 1;
}
