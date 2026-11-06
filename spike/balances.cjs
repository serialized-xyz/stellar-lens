// Spike: rebuild ledger entries from the lake's entry changes over the last N ledgers, then compare
// 200 of them (accounts, trustlines, SAC/SEP-41 balances, classic pools) with Stellar RPC getLedgerEntries.
// Read-only, public endpoints, no install. Usage: node balances.cjs [windowLedgers]
const zlib = require('zlib');
const fs = require('fs');
const { xdr } = require(process.env.STELLAR_SDK ?? '@stellar/stellar-sdk');
const LAKE = 'https://aws-public-blockchain.s3.us-east-2.amazonaws.com/v1.1/stellar/ledgers/pubnet';
const RPCS = ['https://mainnet.sorobanrpc.com', 'https://soroban-rpc.mainnet.stellar.gateway.fm'];
const hex = (n) => (0xffffffff - n).toString(16).toUpperCase().padStart(8, '0');
const keyOf = (seq) => { const s = Math.floor(seq / 64000) * 64000; return `${hex(s)}--${s}-${s + 63999}/${hex(seq)}--${seq}.xdr.zst`; };
const WINDOW = Number(process.argv[2] ?? 180);
const QUOTA = { account: 80, trustline: 70, contract_data: 40, liquidity_pool: 10 };

async function rpc(method, params) {
  for (const url of RPCS) {
    try {
      const r = await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
      if (r.result) return { ...r.result, rpc: url };
      console.log('rpc error', url, JSON.stringify(r.error).slice(0, 200));
    } catch (e) { console.log('rpc fail', url, e.message); }
  }
  throw new Error('all RPCs failed');
}

const state = new Map(); // keyB64 -> { kind, dataJson, lastModified, ledger, removed }
const counters = { changes: 0, created: 0, updated: 0, removed: 0, restored: 0, evicted: 0, keyErrors: 0 };

function keyJsonOf(dataJson) {
  const [kind, d] = Object.entries(dataJson)[0];
  if (kind === 'account') return [kind, { account: { account_id: d.account_id } }];
  if (kind === 'trustline') return [kind, { trustline: { account_id: d.account_id, asset: d.asset } }];
  if (kind === 'contract_data') return [kind, { contract_data: { contract: d.contract, key: d.key, durability: d.durability } }];
  if (kind === 'liquidity_pool') return [kind, { liquidity_pool: { liquidity_pool_id: d.liquidity_pool_id } }];
  return [kind, null];
}

function applyChanges(changes, seq) {
  for (const c of changes ?? []) {
    counters.changes++;
    const t = c.type;
    if (t === 'ledgerEntryState') continue;
    if (t === 'ledgerEntryRemoved') {
      counters.removed++;
      let b64;
      try { b64 = xdr.LedgerKey.fromJson(JSON.parse(JSON.stringify(c.removed))).toXDR('base64'); } catch { counters.keyErrors++; continue; }
      const prev = state.get(b64);
      state.set(b64, { kind: prev?.kind ?? Object.keys(JSON.parse(JSON.stringify(c.removed)))[0], removed: true, ledger: seq });
      continue;
    }
    const entry = c.created ?? c.updated ?? c.restored;
    if (!entry) continue;
    if (t === 'ledgerEntryCreated') counters.created++; else if (t === 'ledgerEntryUpdated') counters.updated++; else counters.restored++;
    const ej = JSON.parse(JSON.stringify(entry));
    const [kind, kj] = keyJsonOf(ej.data);
    if (!kj) continue;
    let b64;
    try { b64 = xdr.LedgerKey.fromJson(kj).toXDR('base64'); } catch { counters.keyErrors++; continue; }
    state.set(b64, { kind, dataJson: JSON.stringify(ej.data), lastModified: ej.last_modified_ledger_seq, ledger: seq, removed: false });
  }
}

(async () => {
  const hz = await (await fetch('https://horizon.stellar.org/ledgers?order=desc&limit=1')).json();
  let tip = hz._embedded.records[0].sequence;
  for (; ; tip--) { const r = await fetch(`${LAKE}/${keyOf(tip)}`, { method: 'HEAD' }); if (r.ok) break; }
  const from = tip - WINDOW + 1;
  console.log('window', from, '->', tip);
  const fetches = [];
  for (let s = from; s <= tip; s++) fetches.push(s);
  // prefetch 8 at a time, apply strictly in ledger order
  const buf = new Map();
  let nextFetch = 0;
  const pull = () => { if (nextFetch < fetches.length) { const s = fetches[nextFetch++]; buf.set(s, fetch(`${LAKE}/${keyOf(s)}`).then((r) => r.arrayBuffer())); } };
  for (let i = 0; i < 8; i++) pull();
  for (const s of fetches) {
    const ab = await buf.get(s); buf.delete(s); pull();
    const lcm = xdr.LedgerCloseMetaBatch.fromXDR(zlib.zstdDecompressSync(Buffer.from(ab))).ledgerCloseMetas[0];
    const m = lcm[lcm.type];
    for (const p of m.txProcessing) applyChanges(p.feeProcessing, s);
    for (const p of m.txProcessing) {
      const tm = p.txApplyProcessing;
      const v = tm[tm.type];
      applyChanges(v.txChangesBefore, s);
      for (const op of v.operations ?? []) applyChanges(op.changes, s);
      applyChanges(v.txChangesAfter, s);
    }
    for (const p of m.txProcessing) applyChanges(p.postTxApplyFeeProcessing, s);
    for (const u of m.upgradesProcessing ?? []) applyChanges(u.changes, s);
    for (const k of m.evictedKeys ?? []) {
      counters.evicted++;
      try { const b64 = xdr.LedgerKey.fromJson(JSON.parse(JSON.stringify(k))).toXDR('base64'); state.set(b64, { kind: 'evicted', removed: true, evicted: true, ledger: s }); } catch { counters.keyErrors++; }
    }
  }
  console.log('applied', counters, 'distinct keys', state.size);

  // pick 200 keys: quotas per kind, spread over the window, contract_data = balance entries only
  const picks = [];
  const byKind = {};
  for (const [k, v] of state) {
    if (v.removed) continue;
    if (v.kind === 'contract_data' && !/^\{"contract_data":\{[^]*"key":\{"vec":\[\{"symbol":"Balance"\}/.test(v.dataJson)) continue;
    (byKind[v.kind] ??= []).push([k, v]);
  }
  for (const [kind, n] of Object.entries(QUOTA)) {
    const arr = byKind[kind] ?? [];
    const step = Math.max(1, Math.floor(arr.length / n));
    for (let i = 0; i < arr.length && picks.filter((p) => p[1].kind === kind).length < n; i += step) picks.push(arr[i]);
  }
  console.log('candidates', Object.fromEntries(Object.entries(byKind).map(([k, a]) => [k, a.length])), 'picked', picks.length);

  let res;
  for (let attempt = 0; attempt < 5; attempt++) {
    res = await rpc('getLedgerEntries', { keys: picks.map((p) => p[0]) });
    if (res.latestLedger >= tip) break;
    console.log('rpc behind the window', res.latestLedger, '<', tip, 'retry');
    await new Promise((r) => setTimeout(r, 3000));
  }
  const got = new Map(res.entries.map((e) => [e.key, e]));
  const out = { window: [from, tip], rpc: res.rpc, rpcLatest: res.latestLedger, byKind: {}, mismatches: [] };
  for (const [k, v] of picks) {
    const r = got.get(k);
    const o = (out.byKind[v.kind] ??= { picked: 0, equal: 0, mismatch: 0, changedAfterWindow: 0, missedChange: 0, rpcBehind: 0, missingInRpc: 0 });
    o.picked++;
    if (!r) { o.missingInRpc++; out.mismatches.push({ kind: v.kind, key: k, why: 'missing in rpc' }); continue; }
    const rl = r.lastModifiedLedgerSeq;
    if (rl === v.lastModified) {
      const rj = JSON.stringify(xdr.LedgerEntryData.fromXDR(r.xdr, 'base64'));
      if (rj === v.dataJson) o.equal++; else { o.mismatch++; out.mismatches.push({ kind: v.kind, key: k, ours: v.dataJson.slice(0, 400), rpc: rj.slice(0, 400) }); }
    } else if (rl > tip) o.changedAfterWindow++;
    else if (rl > v.lastModified) { o.missedChange++; out.mismatches.push({ kind: v.kind, key: k, why: `missed change: rpc ${rl} ours ${v.lastModified}` }); }
    else { o.rpcBehind++; }
  }
  fs.writeFileSync('balances-result.json', JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out.byKind), 'mismatches', out.mismatches.length, 'rpc', out.rpc, 'latest', out.rpcLatest);
})();
