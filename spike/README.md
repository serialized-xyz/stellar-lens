# Validation spike (23 October 2026)

Before building Serialized's own Stellar ingestion, we checked that Stellar mainnet can be read straight from the public ledger archive and decoded with our own code, then compared every result with the official Stellar sources. These are the scripts of that spike, unchanged, with the results of 23 October 2026.

They read public endpoints only: the public ledger archive on AWS Open Data (`aws-public-blockchain`, Galexie format), Horizon, two public Stellar RPC providers and StellarExpert. Nothing is written anywhere except result files in the folder you run them from.

## Results

| Script | What it checks | Reference | Result on 23 October 2026 |
| --- | --- | --- | --- |
| `probe-lake.cjs` | Trades decoded from a ledger file (claim atoms of successful operations) | Horizon `/trades`, paged from the ledger TOID | 6 of 6 ledgers identical (protocols 23, 24 and 29) |
| `day.cjs` | A full UTC day decoded: transactions, operations, trades, XLM/USDC volume, events, 60 sampled ledgers | | 17,280 ledgers in 412 s on 6 workers, 0 error |
| `compare-day.py` | The output of `day.cjs` | Horizon `/trades` and `/trade_aggregations`, StellarExpert ledger stats | 60 of 60 sampled ledgers identical; XLM/USDC equal to the stroop (66,179 trades, 5,352,735.3215374 XLM, 953,463.8934442 USDC); daily counters equal |
| `balances.cjs` | Ledger entries rebuilt from the archive's entry changes over a 15 minute window | Stellar RPC `getLedgerEntries` | 200 entries sampled (80 accounts, 70 trustlines, 40 SAC and SEP-41 balances, 10 pools): 190 of 190 comparable entries identical byte for byte (the other 10 changed after the window) |
| `soroban.cjs` | Soroban swap events (Aquarius, Soroswap) over a 10 minute window | Stellar RPC `getEvents` | 73 of 73 identical |
| `oldfmt.cjs` | CAP-67 events present and readable in older ledger formats | | Present and readable in 2018, 2022 and July 2025 |
| `latency.cjs` | Time after ledger close at which public sources serve a ledger | Ledger close time | gateway.fm RPC p50 1.37 s; sorobanrpc.com RPC p50 1.96 s; archive p50 3.30 s |
| `lake-lag.cjs` | Archive as the only live source, end to end (file available, then downloaded and decoded) | Ledger close time | File available p50 3.06 s; decoded p50 3.28 to 3.77 s |

The "66 of 66" figure quoted in our grant material is `probe-lake.cjs` (6 ledgers) plus the 60 sampled ledgers of `compare-day.py`.

## Run

Requirements: Node 24 or newer (zstd in `node:zlib`), Python 3 for `compare-day.py`, and the Stellar SDK that this repo already pins (`@stellar/stellar-sdk` 17.2.1): run `pnpm install` at the repo root first. To use another copy of the SDK, set `STELLAR_SDK` to its path.

Run each script from a working folder: results are written to the current folder.

```bash
node spike/probe-lake.cjs                 # a few recent ledgers, or give ledger numbers
echo '{"start":65068284,"end":65085563}' > day-range.json   # 22 October 2026, UTC
IN_FLIGHT=8 node spike/day.cjs 6          # 6 workers, writes day-stats.json
python3 spike/compare-day.py              # reads day-stats.json
node spike/balances.cjs 180               # last 180 ledgers (about 15 min)
node spike/soroban.cjs 120                # last 120 ledgers (about 10 min)
node spike/oldfmt.cjs 20000000 40000000 58000000
node spike/latency.cjs 150                # 150 s of polling
node spike/lake-lag.cjs 24                # 24 h run (macOS: caffeinate -i node spike/lake-lag.cjs 24)
```

## Load on public endpoints

Please stay within these orders of magnitude: `day.cjs` downloads about 3.5 GB from the public archive; `compare-day.py` makes about 100 Horizon requests; `latency.cjs` sends about 300 probes to each RPC (one every 500 ms); `lake-lag.cjs` makes about 7 requests per ledger (1.4 per second).
