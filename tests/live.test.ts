// Live test against Stellar mainnet (public Horizon and Stellar RPC).
// Run: node tests/live.test.ts   (Node 24, built-in type stripping)
//
// For the demo account and two other well-known accounts, plus one CAP-38
// liquidity provider picked at run time from Horizon's pool participants:
//   (a) the positions JSON matches the mirrored /v1/wallet/positions schema
//   (b) every trustline balance and the XLM balance equal getLedgerEntries
//   (c) the reserves math holds against the ledger entry
//   (d) every path payment renders as exactly one swap row
// Plus: muxed address parsing, SEP-41 registry ids, price sanity, Verify.

import { MuxedAccount, Account } from '@stellar/stellar-sdk';
import { DEMO_ACCOUNT, SEP41_REGISTRY, USDC_ID } from '../src/data/config.ts';
import { fromStroops, toStroops } from '../src/data/amount.ts';
import { getPayments, findLiquidityPools, getPoolParticipants } from '../src/data/horizon.ts';
import { invalidate } from '../src/data/http.ts';
import { loadPositions } from '../src/data/positions.ts';
import type { PositionsModel } from '../src/data/positions.ts';
import { toActivityRow } from '../src/data/activity.ts';
import { positionsJson, swapsJson, transfersJson } from '../src/data/api.ts';
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

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
class AssertionFailed extends Error {}

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
  { label: 'DECAF wallet (stellar.expert directory, decaf.so)', address: 'GC3XQ7GM6XO36MORCS2SRHHEC2G52FMO4FHPLKUG76EKMTF73ZRH4HWR' },
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
const isNumOrNull = (v: unknown) => v === null || (typeof v === 'number' && Number.isFinite(v));

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
    for (const f of ['amountUsd', 'currentPriceUsd', 'marketCapUsd', 'share'])
      assert(isNumOrNull(row[f]), `${f} must be a number or null on ${String(row.key)}`);
    assert(Array.isArray(row.labels), 'labels not an array');
    const st = row.stellar as Record<string, unknown>;
    assert(st && typeof st.assetType === 'string', `stellar.assetType missing on ${String(row.key)}`);
    if (row.amountUsd === null) assert(typeof st.unpricedReason === 'string' && st.unpricedReason.length > 0, `unpriced row ${String(row.key)} gives no reason`);
    else assert(typeof st.priceSource === 'string', `priced row ${String(row.key)} gives no price source`);
    if (row.kind === 'native') assert(row.address === 'native' && row.key === 'stellar:native:native', 'native row key/address');
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
    const transfers = transfersJson(rows, pageInfo, Date.now());
    for (const t of transfers.data as Array<Record<string, unknown>>) {
      assert(JSON.stringify(Object.keys(t)) === JSON.stringify([...TRANSFER_FIELDS, 'stellar']), `transfer fields ${Object.keys(t).join(',')}`);
      assert(t.direction === 'in' || t.direction === 'out', 'direction');
      assert(typeof t.amount === 'string' && DECIMAL.test(t.amount), 'transfer amount');
    }
    const swaps = swapsJson(rows, pageInfo, Date.now());
    for (const s of swaps.data as Array<Record<string, unknown>>)
      assert(JSON.stringify(Object.keys(s)) === JSON.stringify([...SWAP_FIELDS, 'stellar']), `swap fields ${Object.keys(s).join(',')}`);
    if (!paths.length) return `no path payment in the last ${recs.length} payments (nothing to check); ${transfers.data.length} transfer rows well-formed`;
    const sample = rows.find((r) => r.kind === 'swap')!;
    return `${paths.length}/${recs.length} payments are path payments, each one row (e.g. ${sample.conversion!.source.amount} ${sample.conversion!.source.code} > ${sample.conversion!.destination.amount} ${sample.conversion!.destination.code}); ${transfers.data.length} transfer rows, ${swaps.data.length} swap rows`;
  });
}

await test('swaps mirror: two self path payments in one transaction make one /v1/wallet/swaps row, netted (offline)', async () => {
  const me = DEMO_ACCOUNT.address;
  const tx = { hash: 'ab'.repeat(32), ledger: 1, created_at: '2026-10-16T10:00:00Z', memo_type: 'text' as const, memo: 'x', fee_charged: '200', successful: true, operation_count: 2, source_account: me };
  const leg = (id: string, src: string, dst: string) => ({
    id, paging_token: id, transaction_successful: true, source_account: me, type: 'path_payment_strict_send', created_at: tx.created_at,
    transaction_hash: tx.hash, transaction: tx, from: me, to: me,
    source_asset_type: 'native', source_amount: src,
    asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: USDC_ID.split(':')[1], amount: dst, path: [],
  });
  const rows = [toActivityRow(leg('1', '100.0000000', '18.5000000'), me), toActivityRow(leg('2', '50.0000000', '9.2500000'), me)];
  assert(rows.every((r) => r.kind === 'swap' && r.direction === 'self'), 'self path payments must be swap rows');
  const swaps = swapsJson(rows, { hasMore: false, nextCursor: null }, Date.now());
  assert(swaps.data.length === 1, `expected one swap row per transaction, got ${swaps.data.length}`);
  const s = swaps.data[0] as { sent: Array<{ amount: number }>; received: Array<{ amount: number }>; feesNative: number };
  assert(s.sent[0].amount === 150 && s.received[0].amount === 27.75, `netted amounts wrong: ${JSON.stringify(s)}`);
  assert(s.feesNative === 0.00002, `fee ${s.feesNative}`);
  const transfers = transfersJson(rows, { hasMore: false, nextCursor: null }, Date.now());
  assert(transfers.data.length === 0, 'an own swap is not a transfer');
  return '150 XLM > 27.75 USDC in one row, fee 0.00002 XLM, no transfer rows';
});

await test('Verify button logic: every demo holding matches the ledger (or reports a newer ledger state)', async () => {
  const model = models.get(DEMO_ACCOUNT.address);
  assert(model, 'no demo model');
  const out: string[] = [];
  for (const h of model.holdings) {
    const v = await verifyHolding(h, DEMO_ACCOUNT.address);
    assert(v.status === 'match' || v.status === 'changed', `${h.code}: ${v.status}: ${v.message}`);
    out.push(`${h.code} ${v.status}`);
  }
  return out.join(', ');
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
  const v = await verifyHolding(share, lp.id);
  assert(v.status === 'match' || v.status === 'changed', `pool verify: ${v.status}: ${v.message}`);
  checkPositionsSchema(positionsJson(model), lp.id);
  const [a, b] = share.pool.reserves;
  return `${share.amount} shares (${share.pool.sharePercent.toPrecision(3)}% of pool) = ${a.amount} ${a.code} + ${b.amount} ${b.code}; value ${share.valuation.valueUsd?.toFixed(2) ?? 'unpriced'} USD; ledger ${v.status}`;
});

// ------------------------------------------------------------------ summary

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? `, ${failed.length} failed` : ''}`);
if (failed.length) {
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  process.exitCode = 1;
}
