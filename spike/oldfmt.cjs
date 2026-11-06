// Do CAP-67 events exist, and are they readable in TypeScript, in pre-Protocol-23 ledgers of the lake?
const zlib = require('zlib');
const { xdr } = require(process.env.STELLAR_SDK ?? '@stellar/stellar-sdk');
const LAKE = 'https://aws-public-blockchain.s3.us-east-2.amazonaws.com/v1.1/stellar/ledgers/pubnet';
const hex = (n) => (0xffffffff - n).toString(16).toUpperCase().padStart(8, '0');
const keyOf = (seq) => { const s = Math.floor(seq / 64000) * 64000; return `${hex(s)}--${s}-${s + 63999}/${hex(seq)}--${seq}.xdr.zst`; };
(async () => {
  for (const seq of process.argv.slice(2).map(Number)) {
    const r = await fetch(`${LAKE}/${keyOf(seq)}`);
    const lcm = xdr.LedgerCloseMetaBatch.fromXDR(zlib.zstdDecompressSync(Buffer.from(await r.arrayBuffer()))).ledgerCloseMetas[0];
    const m = lcm[lcm.type];
    const tmv = {}, ev = { opLevel: 0, txLevel: 0, sorobanV3: 0 }, sym = {};
    let tx = 0, ok = 0, payments = 0, pathPays = 0, created = 0;
    for (const p of m.txProcessing) {
      tx++;
      const rs = p.result.result.result;
      const success = rs.type === 'txSuccess' || rs.type === 'txFeeBumpInnerSuccess';
      if (success) ok++;
      const results = rs.results ?? rs.innerResultPair?.result?.result?.results ?? [];
      if (success) for (const x of results) { const t = x.tr?.type; if (t === 'payment') payments++; if (/^pathPayment/.test(t ?? '')) pathPays++; if (t === 'createAccount') created++; }
      const tm = p.txApplyProcessing; tmv[tm.type] = (tmv[tm.type] ?? 0) + 1;
      const v = tm[tm.type];
      const all = [];
      if (tm.type === 'v4') { for (const o of v.operations ?? []) for (const e of o.events ?? []) { ev.opLevel++; all.push(e); } for (const te of v.events ?? []) { ev.txLevel++; all.push(te.event); } }
      if (tm.type === 'v3' && v.sorobanMeta) for (const e of v.sorobanMeta.events ?? []) { ev.sorobanV3++; all.push(e); }
      for (const e of all) { const t0 = e.body?.v0?.topics?.[0]; const s = t0?.type === 'scvSymbol' ? Buffer.from(t0.sym.bytes).toString() : t0?.type; sym[s] = (sym[s] ?? 0) + 1; }
    }
    const close = new Date(Number(m.ledgerHeader.header.scpValue.closeTime) * 1000).toISOString().slice(0, 10);
    console.log(JSON.stringify({ seq, close, protocol: m.ledgerHeader.header.ledgerVersion, ledgerMeta: lcm.type, txMeta: tmv, tx, ok, payments, pathPays, created, events: ev, byTopic: sym }));
  }
})();
