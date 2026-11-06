// Spike: Soroban DEX events (swap / trade) decoded from the lake vs Stellar RPC getEvents, same ledgers.
// Read-only, public endpoints, no install. Usage: node soroban.cjs [windowLedgers]
const zlib = require('zlib');
const fs = require('fs');
const { xdr, StrKey } = require(process.env.STELLAR_SDK ?? '@stellar/stellar-sdk');
const LAKE = 'https://aws-public-blockchain.s3.us-east-2.amazonaws.com/v1.1/stellar/ledgers/pubnet';
const RPC = 'https://mainnet.sorobanrpc.com';
const hex = (n) => (0xffffffff - n).toString(16).toUpperCase().padStart(8, '0');
const keyOf = (seq) => { const s = Math.floor(seq / 64000) * 64000; return `${hex(s)}--${s}-${s + 63999}/${hex(seq)}--${seq}.xdr.zst`; };
const WINDOW = Number(process.argv[2] ?? 120);
const sv = (j) => xdr.ScVal.fromJson(j).toXDR('base64');
const SWAP = sv({ symbol: 'swap' }), TRADE = sv({ symbol: 'trade' });
const isDex = (tj) => {
  const t0 = JSON.stringify(tj[0]), t1 = tj.length > 1 ? JSON.stringify(tj[1]) : '';
  return (t0 === '{"symbol":"trade"}' && tj.length === 4) || t0 === '{"symbol":"swap"}' || t1 === '{"symbol":"swap"}';
};
const label = (tj) => tj.slice(0, 2).map((t) => JSON.stringify(t)).join(',') + `/${tj.length}`;

async function rpc(method, params) {
  const r = await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
  if (!r.result) throw new Error(JSON.stringify(r.error).slice(0, 300));
  return r.result;
}

(async () => {
  const hz = await (await fetch('https://horizon.stellar.org/ledgers?order=desc&limit=1')).json();
  let tip = hz._embedded.records[0].sequence;
  for (; ; tip--) { const r = await fetch(`${LAKE}/${keyOf(tip)}`, { method: 'HEAD' }); if (r.ok) break; }
  const from = tip - WINDOW + 1;
  console.log('window', from, '->', tip);

  // 1. lake side
  const ours = new Map(); // fingerprint -> count
  const oursByLabel = {};
  for (let s = from; s <= tip; s++) {
    const ab = await (await fetch(`${LAKE}/${keyOf(s)}`)).arrayBuffer();
    const lcm = xdr.LedgerCloseMetaBatch.fromXDR(zlib.zstdDecompressSync(Buffer.from(ab))).ledgerCloseMetas[0];
    for (const p of lcm[lcm.type].txProcessing) {
      const tm = p.txApplyProcessing;
      if (tm.type !== 'v4') continue;
      for (const op of tm.v4.operations ?? []) for (const e of op.events ?? []) {
        const ej = JSON.parse(JSON.stringify(e));
        const tj = ej.body.v0.topics;
        if (!isDex(tj)) continue;
        const fp = JSON.stringify([s, ej.contract_id, tj, ej.body.v0.data]);
        ours.set(fp, (ours.get(fp) ?? 0) + 1);
        oursByLabel[label(tj)] = (oursByLabel[label(tj)] ?? 0) + 1;
      }
    }
  }

  // 2. RPC side: same ledgers, topic filters (trailing ** wildcard), paginated
  const filters = [{ type: 'contract', topics: [[TRADE, '*', '*', '*'], [SWAP, '**'], ['*', SWAP, '**']] }];
  const theirs = new Map();
  const theirsByLabel = {};
  let cursor = null, pages = 0, rpcLatest = null;
  for (;;) {
    const params = cursor ? { filters, pagination: { cursor, limit: 1000 } } : { startLedger: from, filters, pagination: { limit: 1000 } };
    const res = await rpc('getEvents', params);
    pages++; rpcLatest = res.latestLedger;
    let past = false;
    for (const ev of res.events) {
      if (ev.ledger > tip) { past = true; break; }
      const tj = ev.topic.map((b) => JSON.parse(JSON.stringify(xdr.ScVal.fromXDR(b, 'base64'))));
      if (!isDex(tj)) continue;
      const data = JSON.parse(JSON.stringify(xdr.ScVal.fromXDR(ev.value, 'base64')));
      const fp = JSON.stringify([ev.ledger, ev.contractId, tj, data]);
      theirs.set(fp, (theirs.get(fp) ?? 0) + 1);
      theirsByLabel[label(tj)] = (theirsByLabel[label(tj)] ?? 0) + 1;
    }
    if (past || res.events.length === 0 || !res.cursor || pages > 50) break;
    cursor = res.cursor;
  }

  const onlyOurs = [...ours].filter(([k, n]) => (theirs.get(k) ?? 0) !== n);
  const onlyTheirs = [...theirs].filter(([k, n]) => (ours.get(k) ?? 0) !== n);
  const sum = (m) => [...m.values()].reduce((a, b) => a + b, 0);
  const out = { window: [from, tip], rpcLatest, pages, ours: sum(ours), theirs: sum(theirs), oursByLabel, theirsByLabel, diffOurs: onlyOurs.length, diffTheirs: onlyTheirs.length, sampleDiff: [...onlyOurs.slice(0, 3), ...onlyTheirs.slice(0, 3)] };
  fs.writeFileSync('soroban-result.json', JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out).slice(0, 1500));
})().catch((e) => console.log('ERROR', e.message));
