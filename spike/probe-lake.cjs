// Probe: public Stellar ledger lake -> zstd -> XDR (@stellar/stellar-sdk) -> claim atoms,
// compared with Horizon /trades paged from the ledger TOID. Read-only, public endpoints, no install.
const zlib = require('zlib');
const { xdr } = require(process.env.STELLAR_SDK ?? '@stellar/stellar-sdk');

const LAKE = 'https://aws-public-blockchain.s3.us-east-2.amazonaws.com/v1.1/stellar/ledgers/pubnet';
const hex = (n) => (0xffffffff - n).toString(16).toUpperCase().padStart(8, '0');
function keyOf(seq) {
  const start = Math.floor(seq / 64000) * 64000;
  return `${hex(start)}--${start}-${start + 63999}/${hex(seq)}--${seq}.xdr.zst`;
}

async function horizonTrades(seq) {
  // Horizon has no ledger-scoped trades route: page /trades from the ledger's TOID (seq << 32) and keep this ledger.
  const lo = BigInt(seq) << 32n, hi = BigInt(seq + 1) << 32n;
  let url = `https://horizon.stellar.org/trades?order=asc&limit=200&cursor=${lo}`;
  let n = 0;
  for (let i = 0; i < 30 && url; i++) {
    const r = await (await fetch(url)).json();
    const recs = r._embedded?.records ?? [];
    if (!r._embedded) { console.log('horizon error', JSON.stringify(r).slice(0, 200)); return null; }
    let done = recs.length < 200;
    for (const t of recs) {
      const op = BigInt(t.paging_token.split('-')[0]);
      if (op >= hi) { done = true; break; }
      if (op > lo) n++;
    }
    url = done ? null : r._links.next.href;
  }
  return n;
}

function claimAtomsOf(opResult) {
  // Generic walk: collect ClaimAtom unions under any offersClaimed / offers array of a successful op result.
  const out = [];
  const walk = (o, d) => {
    if (!o || typeof o !== 'object' || d > 8) return;
    for (const [k, v] of Object.entries(o)) {
      if ((k === 'offersClaimed' || k === 'offers') && Array.isArray(v)) out.push(...v);
      else if (v && typeof v === 'object' && !Buffer.isBuffer(v)) walk(v, d + 1);
    }
  };
  walk(opResult, 0);
  return out.filter((a) => a && typeof a.type === 'string' && a.type.startsWith('claimAtomType'));
}

function atomAmounts(a) {
  const arm = Object.keys(a).find((k) => k !== 'type');
  const v = a[arm];
  return { kind: a.type, sold: BigInt(v.amountSold.toString()), bought: BigInt(v.amountBought.toString()) };
}

async function probe(seq) {
  const t0 = Date.now();
  const res = await fetch(`${LAKE}/${keyOf(seq)}`);
  if (!res.ok) return console.log(seq, 'HTTP', res.status);
  const zst = Buffer.from(await res.arrayBuffer());
  const t1 = Date.now();
  const raw = zlib.zstdDecompressSync(zst);
  const t2 = Date.now();
  const batch = xdr.LedgerCloseMetaBatch.fromXDR(raw);
  const t3 = Date.now();
  const lcm = batch.ledgerCloseMetas[0];
  const v = lcm.type;
  const m = lcm[v];
  const hdr = m.ledgerHeader.header;
  const procs = m.txProcessing;
  let ops = 0, okTx = 0, atoms = 0, zeroAtoms = 0;
  const kinds = {};
  for (const p of procs) {
    const rs = p.result.result.result;
    const name = rs.type;
    let results = null;
    if (name === 'txSuccess' || name === 'txFailed') results = rs.results;
    if (name === 'txFeeBumpInnerSuccess' || name === 'txFeeBumpInnerFailed') results = rs.innerResultPair.result.result.results;
    if (name === 'txSuccess' || name === 'txFeeBumpInnerSuccess') okTx++;
    if (!results) continue;
    ops += results.length;
    if (!(name === 'txSuccess' || name === 'txFeeBumpInnerSuccess')) continue;
    for (const r of results) for (const a of claimAtomsOf(r)) {
      const x = atomAmounts(a);
      if (x.sold === 0n && x.bought === 0n) { zeroAtoms++; continue; }
      atoms++; kinds[x.kind] = (kinds[x.kind] ?? 0) + 1;
    }
  }
  const hz = await horizonTrades(seq);
  console.log(JSON.stringify({
    seq, metaVersion: v, protocol: hdr.ledgerVersion, closeTime: new Date(Number(hdr.scpValue.closeTime.toString()) * 1000).toISOString(),
    zstKB: Math.round(zst.length / 1024), rawKB: Math.round(raw.length / 1024),
    ms: { download: t1 - t0, zstd: t2 - t1, decode: t3 - t2 },
    tx: procs.length, okTx, ops, claimAtoms: atoms, zeroAtoms, kinds, horizonTrades: hz, match: atoms === hz,
  }));
}

(async () => {
  const tip = (await (await fetch('https://horizon.stellar.org/ledgers?order=desc&limit=1')).json())._embedded.records[0].sequence;
  const seqs = process.argv.slice(2).map(Number);
  for (const s of seqs.length ? seqs : [tip - 20, tip - 21, tip - 500, tip - 5000]) {
    try { await probe(s); } catch (e) { console.log(s, 'ERROR', e.message); }
  }
})();
