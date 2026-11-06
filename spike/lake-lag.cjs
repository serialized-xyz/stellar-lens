// Long-running lag measurement of the public lake as the ONLY live source (no RPC).
// For each ledger: HEAD-poll its file from 1 s after its expected close (5 s cadence), every 200 ms, then GET and
// decode it. A ledger counts only if we saw at least one 404 before the 200 (we were waiting, so the time is exact
// to 200 ms); a ledger already present at the first poll (we were late: sleep, network) is logged but excluded.
// Writes lake-lag.jsonl (one line per ledger) and lake-lag-summary.json (every 10 min). Read-only.
// Usage: node lake-lag.cjs [hours]   (macOS: caffeinate -i node lake-lag.cjs 24)
const fs = require('fs');
const zlib = require('zlib');
const { xdr } = require(process.env.STELLAR_SDK ?? '@stellar/stellar-sdk');
const LAKE = 'https://aws-public-blockchain.s3.us-east-2.amazonaws.com/v1.1/stellar/ledgers/pubnet';
const hex = (n) => (0xffffffff - n).toString(16).toUpperCase().padStart(8, '0');
const keyOf = (seq) => { const s = Math.floor(seq / 64000) * 64000; return `${hex(s)}--${s}-${s + 63999}/${hex(seq)}--${seq}.xdr.zst`; };
const HOURS = Number(process.argv[2] ?? 24);
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const startedAt = Date.now();
const lags = [], excluded = [], stalls = [];
let errors = 0, requests = 0;

const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return Number(s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(2)); };
function summary(final) {
  const hrs = {};
  for (const x of lags) (hrs[new Date(x.close).toISOString().slice(0, 13)] ??= []).push(x.lagDecoded);
  return {
    final, startedAt: new Date(startedAt).toISOString(), updatedAt: new Date().toISOString(),
    ledgers: lags.length, excluded: excluded.length, errors, requests,
    availableAfterClose_s: { p50: pct(lags.map((x) => x.lagAvail), 0.5), p95: pct(lags.map((x) => x.lagAvail), 0.95), p99: pct(lags.map((x) => x.lagAvail), 0.99), max: pct(lags.map((x) => x.lagAvail), 1) },
    decodedAfterClose_s: { p50: pct(lags.map((x) => x.lagDecoded), 0.5), p95: pct(lags.map((x) => x.lagDecoded), 0.95), p99: pct(lags.map((x) => x.lagDecoded), 0.99), max: pct(lags.map((x) => x.lagDecoded), 1) },
    over10s: lags.filter((x) => x.lagDecoded > 10).length, over30s: lags.filter((x) => x.lagDecoded > 30).length,
    stalls, perHourP95: Object.fromEntries(Object.entries(hrs).map(([h, a]) => [h, pct(a, 0.95)])),
  };
}

(async () => {
  const hz = await (await fetch('https://horizon.stellar.org/ledgers?order=desc&limit=1')).json();
  let seq = hz._embedded.records[0].sequence + 1;
  let expectedClose = Date.parse(hz._embedded.records[0].closed_at) + 5000;
  const out = fs.createWriteStream('lake-lag.jsonl', { flags: 'a' });
  let lastSummary = Date.now();
  while (Date.now() - startedAt < HOURS * 3600e3) {
    await sleep(expectedClose + 1000 - Date.now());
    let polls = 0, sawMissing = false, availAt = null;
    const pollStart = Date.now();
    while (availAt === null) {
      const t = Date.now();
      try {
        requests++;
        const r = await fetch(`${LAKE}/${keyOf(seq)}`, { method: 'HEAD' });
        polls++;
        if (r.status === 200) availAt = Date.now(); else sawMissing = true;
      } catch { errors++; }
      if (availAt === null) {
        if (Date.now() - pollStart > 30000 && !stalls.find((s) => s.seq === seq)) stalls.push({ seq, since: new Date(pollStart).toISOString() });
        await sleep(200 - (Date.now() - t));
      }
    }
    let close, decodedAt, bytes;
    try {
      requests++;
      const buf = Buffer.from(await (await fetch(`${LAKE}/${keyOf(seq)}`)).arrayBuffer());
      const lcm = xdr.LedgerCloseMetaBatch.fromXDR(zlib.zstdDecompressSync(buf)).ledgerCloseMetas[0];
      close = Number(lcm[lcm.type].ledgerHeader.header.scpValue.closeTime) * 1000;
      decodedAt = Date.now(); bytes = buf.length;
    } catch (e) { errors++; await sleep(1000); continue; }
    const row = { seq, close, lagAvail: (availAt - close) / 1000, lagDecoded: (decodedAt - close) / 1000, polls, waited: sawMissing, bytes };
    out.write(JSON.stringify(row) + '\n');
    (sawMissing ? lags : excluded).push(row);
    const s = stalls.find((x) => x.seq === seq); if (s) s.until = new Date(availAt).toISOString();
    seq++;
    expectedClose = close + 5000;
    if (Date.now() - expectedClose > 15000) expectedClose = Date.now() - 1000; // we are behind: poll at once
    if (Date.now() - lastSummary > 600e3) { fs.writeFileSync('lake-lag-summary.json', JSON.stringify(summary(false), null, 1)); lastSummary = Date.now(); }
  }
  fs.writeFileSync('lake-lag-summary.json', JSON.stringify(summary(true), null, 1));
  out.end();
})();
