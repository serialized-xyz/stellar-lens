"""Compare day-stats.json (written by day.cjs) with Horizon and StellarExpert. Stdlib only, read-only.

- the 60 sampled ledgers: trade count = Horizon /trades paged from the ledger TOID (seq << 32);
- XLM/USDC (Circle) of the day = Horizon /trade_aggregations at a one-day resolution;
- day counters (ledgers, successful and failed transactions, operations) = StellarExpert ledger-stats.
Usage: python3 compare-day.py  (run in the folder holding day-stats.json)
"""
import datetime
import json
import urllib.request

USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'


def get(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'serialized-stellar-spike'})
    return json.load(urllib.request.urlopen(req, timeout=40))


def horizon_trades(seq):
    lo, hi = seq << 32, (seq + 1) << 32
    url = f'https://horizon.stellar.org/trades?order=asc&limit=200&cursor={lo}'
    n = 0
    for _ in range(40):
        page = get(url)
        recs = page['_embedded']['records']
        stop = len(recs) < 200
        for t in recs:
            op = int(t['paging_token'].split('-')[0])
            if op >= hi:
                stop = True
                break
            if op > lo:
                n += 1
        if stop:
            return n
        url = page['_links']['next']['href']
    raise RuntimeError(f'ledger {seq}: more than 40 pages')


day = json.load(open('day-stats.json'))

equal, diffs, ours_total, hz_total = 0, [], 0, 0
for seq, ours in sorted(day['sample'].items(), key=lambda x: int(x[0])):
    n = horizon_trades(int(seq))
    ours_total += ours
    hz_total += n
    if n == ours:
        equal += 1
    else:
        diffs.append((int(seq), ours, n))
print(f"sampled ledgers {len(day['sample'])}: equal {equal}, trades ours {ours_total} horizon {hz_total}, diffs {diffs[:10]}")

first_close = get(f"https://horizon.stellar.org/ledgers/{day['range']['start']}")['closed_at']
day_start = datetime.datetime.fromisoformat(first_close.replace('Z', '+00:00')).replace(hour=0, minute=0, second=0)
start_ms = int(day_start.timestamp() * 1000)
agg = get('https://horizon.stellar.org/trade_aggregations?base_asset_type=native&counter_asset_type=credit_alphanum4'
          f'&counter_asset_code=USDC&counter_asset_issuer={USDC_ISSUER}'
          f'&start_time={start_ms}&end_time={start_ms + 86400000}&resolution=86400000')['_embedded']['records']
x = day['xlmUsdc']
print('XLM/USDC horizon', [(r['trade_count'], r['base_volume'], r['counter_volume']) for r in agg])
print('XLM/USDC ours   ', x['n'], int(x['xlm']) / 1e7, int(x['usdc']) / 1e7)

rows = get('https://api.stellar.expert/explorer/public/ledger/ledger-stats')
row = next(r for r in rows if r['ts'] == start_ms // 1000)
print('stellar.expert ', {k: row[k] for k in ('ledgers', 'transactions', 'failed_transactions', 'operations', 'trades')})
print('ours           ', {'ledgers': day['ledgers'], 'transactions': day['txOk'], 'failed_transactions': day['txFail'],
                          'operations': day['opsOk'], 'trades (Horizon definition)': sum(day['atoms'].values())})
