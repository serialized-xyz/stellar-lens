// Spike: decode one full UTC day of Stellar ledgers from the public lake (read-only, no install).
// Usage: node day.cjs [workers]  -> writes day-stats.json
const { Worker, isMainThread, workerData, parentPort } = require('worker_threads');
const fs = require('fs');
const zlib = require('zlib');
const SDK = process.env.STELLAR_SDK ?? '@stellar/stellar-sdk';
const LAKE = 'https://aws-public-blockchain.s3.us-east-2.amazonaws.com/v1.1/stellar/ledgers/pubnet';
const USDC = JSON.stringify({ credit_alphanum4: { asset_code: 'USDC', issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN' } });
const NATIVE = '"native"';
const SAMPLE_STEP = 288; // 60 sampled ledgers per day for the Horizon comparison

const hex = (n) => (0xffffffff - n).toString(16).toUpperCase().padStart(8, '0');
const keyOf = (seq) => {
  const s = Math.floor(seq / 64000) * 64000;
  return `${hex(s)}--${s}-${s + 63999}/${hex(seq)}--${seq}.xdr.zst`;
};
const inc = (o, k, n = 1) => { o[k] = (o[k] ?? 0) + n; };

if (isMainThread) {
  const { start, end } = JSON.parse(fs.readFileSync(process.env.RANGE_FILE ?? 'day-range.json', 'utf8'));
  const W = Number(process.argv[2] ?? 6);
  const t0 = Date.now();
  let done = 0;
  const parts = [];
  const workers = [...Array(W).keys()].map((w) => new Promise((resolve, reject) => {
    const wk = new Worker(__filename, { workerData: { start, end, w, W } });
    wk.on('message', (m) => {
      if (m.progress) { done += m.progress; if (done % 2000 < m.progress) console.log(`progress ${done}/${end - start + 1} ${Math.round((Date.now() - t0) / 1000)} s`); }
      if (m.result) { parts.push(m.result); resolve(); }
    });
    wk.on('error', reject);
  }));
  Promise.all(workers).then(() => {
    const agg = merge(parts);
    agg.wallSeconds = Math.round((Date.now() - t0) / 1000);
    agg.range = { start, end };
    fs.writeFileSync(process.env.OUT ?? 'day-stats.json', JSON.stringify(agg, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 1));
    console.log('written', process.env.OUT ?? 'day-stats.json', agg.ledgers, 'ledgers in', agg.wallSeconds, 's');
  });
} else {
  const { xdr, StrKey } = require(SDK);
  const { start, end, w, W } = workerData;
  const seqs = [];
  for (let s = start + w; s <= end; s += W) seqs.push(s);
  const agg = newAgg();

  const fetchLedger = async (seq) => {
    for (let i = 0; i < 4; i++) {
      try {
        const t = Date.now();
        const r = await fetch(`${LAKE}/${keyOf(seq)}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return { seq, buf: Buffer.from(await r.arrayBuffer()), ms: Date.now() - t };
      } catch (e) {
        if (i === 3) return { seq, err: e.message };
        await new Promise((res) => setTimeout(res, 500 * 2 ** i));
      }
    }
  };

  const topicStr = (t) => {
    if (!t) return '-';
    if (t.type === 'scvSymbol') return 'sym:' + Buffer.from(t.sym.bytes).toString();
    if (t.type === 'scvString') return 'str:' + Buffer.from((t.str.bytes ?? t.str)).toString();
    return t.type;
  };

  const processLedger = ({ seq, buf, ms }) => {
    const td = Date.now();
    const raw = zlib.zstdDecompressSync(buf);
    const lcm = xdr.LedgerCloseMetaBatch.fromXDR(raw).ledgerCloseMetas[0];
    const m = lcm[lcm.type];
    const dec = Date.now() - td;
    agg.ledgers++; agg.zst += buf.length; agg.raw += raw.length; agg.dlMs += ms; agg.decMs += dec;
    agg.maxDecMs = Math.max(agg.maxDecMs, dec);
    inc(agg.metaVersions, lcm.type);
    let atomsThisLedger = 0;
    for (const p of m.txProcessing) {
      agg.tx++;
      const rs = p.result.result.result;
      let results = null, ok = false;
      if (rs.type === 'txSuccess' || rs.type === 'txFailed') results = rs.results;
      if (rs.type === 'txFeeBumpInnerSuccess' || rs.type === 'txFeeBumpInnerFailed') { agg.feeBump++; results = rs.innerResultPair.result.result.results; }
      ok = rs.type === 'txSuccess' || rs.type === 'txFeeBumpInnerSuccess';
      if (ok) agg.txOk++; else { agg.txFail++; inc(agg.txFailCodes, rs.type); }
      if (results) {
        agg.opsAll += results.length;
        if (ok) agg.opsOk += results.length;
        for (const r of results) {
          const t = r.type === 'opInner' ? r.tr.type : r.type;
          inc(ok ? agg.opTypesOk : agg.opTypesFail, t);
          if (!ok || r.type !== 'opInner') continue;
          const s = JSON.stringify(r.tr);
          if (!s.includes('offers')) continue;
          const atoms = [];
          const walk = (o, d) => {
            if (!o || typeof o !== 'object' || d > 8 || o instanceof Uint8Array) return;
            for (const [k, v] of Object.entries(o)) {
              if ((k === 'offersClaimed' || k === 'offers') && Array.isArray(v)) atoms.push(...v);
              else walk(v, d + 1);
            }
          };
          walk(r.tr, 0);
          for (const a of atoms) {
            if (!a || typeof a.type !== 'string' || !a.type.startsWith('claimAtomType')) continue;
            const v = a.orderBook ?? a.liquidityPool ?? a.v0;
            const sold = BigInt(v.amountSold), bought = BigInt(v.amountBought);
            if (sold === 0n && bought === 0n) { agg.zeroAtoms++; continue; }
            atomsThisLedger++;
            inc(agg.atoms, a.type.replace('claimAtomType', ''));
            const as = JSON.stringify(v.assetSold), ab = JSON.stringify(v.assetBought);
            if ((as === NATIVE && ab === USDC) || (as === USDC && ab === NATIVE)) {
              agg.xlmUsdc.n++;
              agg.xlmUsdc.xlm += as === NATIVE ? sold : bought;
              agg.xlmUsdc.usdc += as === USDC ? sold : bought;
              inc(agg.xlmUsdc.byKind, a.type.replace('claimAtomType', ''));
            }
          }
        }
      }
      // events (TransactionMeta v4 only: op-level contract events + tx-level events)
      const tm = p.txApplyProcessing;
      inc(agg.txMetaVersions, tm.type);
      const v4 = tm.type === 'v4' ? tm.v4 : null;
      const evs = [];
      if (v4) {
        for (const op of v4.operations ?? []) for (const e of op.events ?? []) evs.push(['op', e]);
        for (const te of v4.events ?? []) evs.push(['tx', te.event]);
      } else if (tm.type === 'v3' && tm.v3.sorobanMeta) {
        for (const e of tm.v3.sorobanMeta.events ?? []) evs.push(['soroban-v3', e]);
      }
      for (const [where, e] of evs) {
        agg.events[where] = (agg.events[where] ?? 0) + 1;
        const topics = e.body?.v0?.topics ?? [];
        const t0 = topicStr(topics[0]), t1 = topics.length > 1 ? topicStr(topics[1]) : '-';
        const key = `${t0}|${/^(sym|str):/.test(t1) ? t1 : '*'}|${topics.length}`;
        inc(agg.eventKeys, key);
        if (/swap|trade/i.test(key)) {
          const cid = e.contractId ? StrKey.encodeContract(Buffer.from(e.contractId.value ?? e.contractId)) : 'none';
          agg.dexContracts[key] ??= {};
          inc(agg.dexContracts[key], cid);
        }
      }
    }
    if ((seq - start) % SAMPLE_STEP === 0) agg.sample[seq] = atomsThisLedger;
  };

  (async () => {
    const IN_FLIGHT = Number(process.env.IN_FLIGHT ?? 4);
    let next = 0;
    const pending = [];
    const launch = () => { if (next < seqs.length) pending.push(fetchLedger(seqs[next++])); };
    for (let i = 0; i < IN_FLIGHT; i++) launch();
    let sinceReport = 0;
    while (pending.length) {
      const got = await pending.shift();
      launch();
      if (got.err) { agg.errors.push([got.seq, got.err]); continue; }
      try { processLedger(got); } catch (e) { agg.errors.push([got.seq, e.message]); }
      if (++sinceReport === 100) { parentPort.postMessage({ progress: 100 }); sinceReport = 0; }
    }
    parentPort.postMessage({ progress: sinceReport, result: agg });
  })();
}

function newAgg() {
  return {
    ledgers: 0, zst: 0, raw: 0, dlMs: 0, decMs: 0, maxDecMs: 0, metaVersions: {}, txMetaVersions: {},
    tx: 0, txOk: 0, txFail: 0, feeBump: 0, txFailCodes: {},
    opsAll: 0, opsOk: 0, opTypesOk: {}, opTypesFail: {},
    atoms: {}, zeroAtoms: 0, xlmUsdc: { n: 0, xlm: 0n, usdc: 0n, byKind: {} },
    events: {}, eventKeys: {}, dexContracts: {}, sample: {}, errors: [],
  };
}

function merge(parts) {
  const out = newAgg();
  const addObj = (dst, src) => { for (const [k, v] of Object.entries(src)) dst[k] = (dst[k] ?? 0) + v; };
  for (const p of parts) {
    for (const k of ['ledgers', 'zst', 'raw', 'dlMs', 'decMs', 'tx', 'txOk', 'txFail', 'feeBump', 'opsAll', 'opsOk', 'zeroAtoms']) out[k] += p[k];
    out.maxDecMs = Math.max(out.maxDecMs, p.maxDecMs);
    for (const k of ['metaVersions', 'txMetaVersions', 'txFailCodes', 'opTypesOk', 'opTypesFail', 'atoms', 'events', 'eventKeys']) addObj(out[k], p[k]);
    out.xlmUsdc.n += p.xlmUsdc.n; out.xlmUsdc.xlm += BigInt(p.xlmUsdc.xlm); out.xlmUsdc.usdc += BigInt(p.xlmUsdc.usdc);
    addObj(out.xlmUsdc.byKind, p.xlmUsdc.byKind);
    for (const [k, v] of Object.entries(p.dexContracts)) { out.dexContracts[k] ??= {}; addObj(out.dexContracts[k], v); }
    Object.assign(out.sample, p.sample);
    out.errors.push(...p.errors);
  }
  return out;
}
