// Baseline latency of PUBLIC sources: time we first see ledger N minus N's close time (1 s resolution).
// Polls every 500 ms for DURATION seconds. Read-only. Usage: node latency.cjs [seconds]
const LAKE = 'https://aws-public-blockchain.s3.us-east-2.amazonaws.com/v1.1/stellar/ledgers/pubnet';
const RPCS = { sorobanrpc: 'https://mainnet.sorobanrpc.com', gatewayfm: 'https://soroban-rpc.mainnet.stellar.gateway.fm' };
const hex = (n) => (0xffffffff - n).toString(16).toUpperCase().padStart(8, '0');
const keyOf = (seq) => { const s = Math.floor(seq / 64000) * 64000; return `${hex(s)}--${s}-${s + 63999}/${hex(seq)}--${seq}.xdr.zst`; };
const DURATION = Number(process.argv[2] ?? 150) * 1000;
const seen = {}; // source -> seq -> first seen ms
const mark = (src, seq, t) => { seen[src] ??= {}; if (!(seq in seen[src])) seen[src][seq] = t; };
(async () => {
  const hz = await (await fetch('https://horizon.stellar.org/ledgers?order=desc&limit=1')).json();
  let next = hz._embedded.records[0].sequence + 1;
  const t0 = Date.now();
  const tasks = [];
  for (const [name, url] of Object.entries(RPCS)) tasks.push((async () => {
    while (Date.now() - t0 < DURATION) {
      const t = Date.now();
      try {
        const r = await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' })).json();
        const s = r.result?.latestLedger; const tt = Date.now();
        if (s) mark(name, s, tt);
      } catch {}
      await new Promise((res) => setTimeout(res, Math.max(0, 500 - (Date.now() - t))));
    }
  })());
  tasks.push((async () => {
    let s = next;
    while (Date.now() - t0 < DURATION) {
      const t = Date.now();
      try { const r = await fetch(`${LAKE}/${keyOf(s)}`, { method: 'HEAD' }); if (r.ok) { mark('lake', s, Date.now()); s++; continue; } } catch {}
      await new Promise((res) => setTimeout(res, Math.max(0, 500 - (Date.now() - t))));
    }
  })());
  await Promise.all(tasks);
  const r = await (await fetch('https://horizon.stellar.org/ledgers?order=desc&limit=200')).json();
  const close = Object.fromEntries(r._embedded.records.map((x) => [x.sequence, Date.parse(x.closed_at)]));
  const out = {};
  for (const [src, m] of Object.entries(seen)) {
    const d = Object.entries(m).filter(([s]) => close[s] && Number(s) >= next).map(([s, t]) => (t - close[s]) / 1000).sort((a, b) => a - b);
    const q = (p) => d.length ? d[Math.min(d.length - 1, Math.floor(p * d.length))].toFixed(2) : null;
    out[src] = { ledgers: d.length, min: q(0), p50: q(0.5), p95: q(0.95), max: d.length ? d[d.length - 1].toFixed(2) : null };
  }
  console.log(JSON.stringify(out));
})();
