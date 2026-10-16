import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { fromStroops } from '../data/amount.ts';
import { explorer } from '../data/config.ts';
import type { CreditHolding, Holding, PositionsModel, Valuation } from '../data/positions.ts';
import { shortAddress } from '../data/stellar.ts';
import type { Verification } from '../data/toml.ts';
import { verifyHolding } from '../data/verify.ts';
import type { VerifyResult } from '../data/verify.ts';
import { fmtAmount, fmtAmountShort, fmtInt, fmtPct, fmtPriceUsd, fmtUsd } from '../lib/format.ts';
import { AccountLink, AssetMark, Badge, CopyButton, ExtLink, Icon, Skeleton, Spinner } from './ui.tsx';

const SOURCE_LABEL: Record<string, string> = {
  usdc_peg: 'Face value',
  sdex_orderbook_mid: 'SDEX order book',
  sdex_amm_path: 'SDEX/AMM path',
  underlying_reserves: 'Pool reserves',
};

function PriceCell({ v }: { v: Valuation }) {
  if (v.state === 'pending') return <Skeleton w={72} />;
  if (v.state === 'zero') return <span className="muted">not priced</span>;
  if (v.priceUsd === null)
    return (
      <span className="unpriced" title={v.reason ?? ''}>
        unpriced
      </span>
    );
  return (
    <span className="cell-stack">
      <span className="mono num">{fmtPriceUsd(v.priceUsd)}</span>
      <span className="src" title={v.detail ?? ''}>
        {v.source ? SOURCE_LABEL[v.source] : ''}
      </span>
    </span>
  );
}

/** A few words for the Value cell; the full reason is in the row details ("Why unpriced") and the tooltip. */
export function shortReason(reason: string | null): string {
  if (!reason) return '';
  const rules: Array<[RegExp, string]> = [
    [/mint facility/i, 'mint facility, not a market'],
    [/market-depth check of this balance was not run/i, 'beyond pricing budget, depth not checked'],
    [/prices at most \d+ holdings/i, 'beyond this preview\'s pricing budget'],
    [/no SDEX or classic pool path/i, 'no SDEX or classic pool path'],
    [/no path to USDC/i, 'no path to USDC'],
    [/too thin/i, 'market too thin'],
    [/absurd price/i, 'absurd price rejected'],
    [/exceeds what SDEX and classic pools can absorb/i, 'balance exceeds market depth'],
    [/Soroban-native/i, 'no classic market in this preview'],
    [/underlying reserve unpriced/i, 'a pool reserve is unpriced'],
    [/rate limited/i, 'rate limited, retry later'],
    [/path finding failed|depth check failed/i, 'price lookup failed'],
    [/pool (unavailable|not found)/i, 'pool unavailable'],
    [/zero balance/i, 'zero balance'],
  ];
  for (const [re, label] of rules) if (re.test(reason)) return label;
  const first = reason.split(/[:(;]/)[0].trim();
  return first.length > 44 ? `${first.slice(0, 42)}...` : first;
}

function ValueCell({ v }: { v: Valuation }) {
  if (v.state === 'pending') return <Skeleton w={88} />;
  if (v.valueUsd === null)
    return (
      <span className="cell-stack">
        <span className="unpriced">unpriced</span>
        <span className="src reason" title={v.reason ?? ''}>
          {shortReason(v.reason)}
        </span>
      </span>
    );
  return (
    <span className="cell-stack">
      <span className="mono num strong">{fmtUsd(v.valueUsd)}</span>
      {v.depthRatio !== null && v.priceUsd !== null ? (
        <span className="src depth" title={`Proceeds of selling the whole balance in one path payment now (${fmtPct(v.depthRatio * 100, 1)} of the spot value), as the Serialized API values positions at market depth`}>
          at depth, spot {fmtUsd(v.valueUsd / v.depthRatio)}
        </span>
      ) : null}
    </span>
  );
}

function VerificationLine({ h }: { h: CreditHolding }) {
  const v: Verification | null = h.verification;
  const issuer = (
    <ExtLink href={explorer.account(h.issuer)} className="mono addr" title={`Issuer ${h.issuer}`}>
      {shortAddress(h.issuer)}
    </ExtLink>
  );
  if (!v)
    return (
      <span className="asset-sub">
        {issuer} <Skeleton w={60} h={10} />
      </span>
    );
  if (v.status === 'verified')
    return (
      <span className="asset-sub">
        <span className="verified" title={`Listed in https://${v.domain}/.well-known/stellar.toml${v.orgName ? ` (${v.orgName})` : ''}`}>
          <Icon name="check" size={12} />
          {v.domain}
        </span>
        {issuer}
      </span>
    );
  const domain = 'domain' in v ? v.domain : null;
  return (
    <span className="asset-sub">
      {domain ? (
        <span className="domain" title={v.detail}>
          {domain}
        </span>
      ) : null}
      {issuer}
      <span className="unverified" title={v.detail}>
        {v.status === 'no_home_domain'
          ? 'no home domain'
          : v.status === 'not_listed'
            ? 'not in stellar.toml'
            : v.status === 'not_checked'
              ? 'not checked'
              : v.status === 'issuer_missing'
                ? 'issuer merged'
                : 'toml unavailable'}
      </span>
    </span>
  );
}

function AssetCell({ h }: { h: Holding }) {
  switch (h.type) {
    case 'native':
      return (
        <div className="asset">
          <AssetMark code="XLM" seed="native" kind="native" />
          <div className="asset-text">
            <span className="asset-line">
              <span className="asset-code">XLM</span>
              <span className="asset-name">Stellar Lumens</span>
            </span>
            <span className="asset-sub">native asset</span>
          </div>
        </div>
      );
    case 'credit':
      return (
        <div className="asset">
          <AssetMark code={h.code} seed={h.assetId} />
          <div className="asset-text">
            <span className="asset-line">
              <ExtLink href={h.explorerUrl} className="asset-code" title={h.assetId}>
                {h.code}
              </ExtLink>
              {h.name ? <span className="asset-name">{h.name}</span> : null}
              {h.flags.clawbackEnabled ? (
                <Badge tone="warn" title="The issuer can claw back this balance (CAP-35)">
                  clawback
                </Badge>
              ) : null}
              {!h.flags.authorized ? (
                <Badge tone="bad" title={h.flags.authorizedToMaintainLiabilities ? 'Authorized to maintain liabilities only' : 'Trustline not authorized by the issuer'}>
                  {h.flags.authorizedToMaintainLiabilities ? 'liabilities only' : 'not authorized'}
                </Badge>
              ) : null}
              {h.sponsor ? (
                <Badge tone="muted" title={`Reserve sponsored by ${h.sponsor}`}>
                  sponsored
                </Badge>
              ) : null}
            </span>
            <VerificationLine h={h} />
          </div>
        </div>
      );
    case 'pool_share':
      return (
        <div className="asset">
          <AssetMark code="LP" seed={h.poolId} kind="pool" />
          <div className="asset-text">
            <span className="asset-line">
              <ExtLink href={h.explorerUrl} className="asset-code" title={h.poolId}>
                {h.pool ? h.pool.reserves.map((r) => r.code).join(' / ') : 'Pool share'}
              </ExtLink>
              <Badge tone="accent" title="CAP-38 constant product pool share">
                pool share
              </Badge>
            </span>
            <span className="asset-sub">
              <span className="mono">{shortAddress(h.poolId, 6, 6)}</span>
              {h.pool ? <span>fee {h.pool.feeBp / 100}%</span> : null}
            </span>
          </div>
        </div>
      );
    case 'sep41':
      return (
        <div className="asset">
          <AssetMark code={h.code} seed={h.contractId} kind="sep41" />
          <div className="asset-text">
            <span className="asset-line">
              <ExtLink href={h.explorerUrl} className="asset-code" title={h.contractId}>
                {h.code}
              </ExtLink>
              <span className="asset-name">{h.name}</span>
              <Badge tone="accent" title="Soroban token read with balance() simulation">
                SEP-41
              </Badge>
            </span>
            <span className="asset-sub">
              <span className="mono">{shortAddress(h.contractId)}</span>
              <span>{h.registry.project}</span>
            </span>
          </div>
        </div>
      );
  }
}

function BalanceCell({ h }: { h: Holding }) {
  const unit = h.type === 'pool_share' ? 'shares' : '';
  return (
    <span className="cell-stack">
      <span className="mono num" title={h.amount}>
        {fmtAmountShort(h.amount)} {unit ? <span className="unit">{unit}</span> : null}
      </span>
      {h.type === 'native' ? <span className="src">{fmtAmountShort(fromStroops(h.reserves.spendable))} spendable</span> : null}
      {h.type === 'pool_share' && h.pool ? <span className="src">{fmtPct(h.pool.sharePercent, 4)} of pool</span> : null}
    </span>
  );
}

const verifyTone = (r: VerifyResult) => (r.status === 'match' ? 'ok' : r.status === 'changed' || r.status === 'behind' ? 'warn' : 'bad');
const VERIFY_LABEL: Record<VerifyResult['status'], string> = {
  match: 'Matches',
  changed: 'Changed',
  behind: 'RPC behind',
  mismatch: 'Mismatch',
  missing: 'Missing',
  error: 'Error',
};

function VerifyPanel({ r }: { r: VerifyResult }) {
  const tone = verifyTone(r);
  return (
    <div className={`verify-panel verify-${tone}`}>
      <div className="verify-head">
        <Icon name={r.status === 'match' ? 'shield' : 'alert'} size={15} />
        <span>{r.message}</span>
      </div>
      {r.checks.length ? (
        <table className="verify-table">
          <thead>
            <tr>
              <th>Field</th>
              <th>Horizon</th>
              <th>Ledger (RPC)</th>
              <th className="vt-icon" />
            </tr>
          </thead>
          <tbody>
            {r.checks.map((c) => (
              <tr key={c.field} className={c.equal ? '' : 'diff'}>
                <td>{c.field}</td>
                <td className="mono">{c.shown}</td>
                <td className="mono">{c.ledger}</td>
                <td className="vt-icon">{c.equal ? <Icon name="check" size={13} /> : <Icon name="alert" size={13} />}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <div className="verify-meta">
        {r.method ?? 'Stellar RPC'}{r.endpoint ? ` on ${new URL(r.endpoint).host}` : ''}
        {r.ledger ? <> · latest ledger #{fmtInt(r.ledger)}</> : null}
        {r.entryLastModified ? <> · entry last modified in #{fmtInt(r.entryLastModified)}</> : null}
      </div>
    </div>
  );
}

function Kv({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="kv">
      <span className="kv-k">{k}</span>
      <span className="kv-v">{children}</span>
    </div>
  );
}

function Details({ h, account }: { h: Holding; account: string }) {
  const v = h.valuation;
  const priceTrace = v.detail ? <Kv k="Price trace">{v.detail}</Kv> : null;
  const why = v.state === 'unpriced' && v.reason ? <Kv k="Why unpriced">{v.reason}</Kv> : null;
  switch (h.type) {
    case 'native': {
      const r = h.reserves;
      return (
        <div className="details-grid">
          <div className="reserves">
            <div className="reserves-title">XLM reserves</div>
            <div className="reserve-row">
              <span>Total balance</span>
              <span className="mono">{fmtAmount(fromStroops(r.total))}</span>
            </div>
            <div className="reserve-row">
              <span>
                Minimum balance
                <small>
                  (2 + {r.subentryCount} subentries + {r.numSponsoring} sponsoring - {r.numSponsored} sponsored) × {fromStroops(r.baseReserveStroops)} XLM
                </small>
              </span>
              <span className="mono">{fmtAmount(fromStroops(r.minimumBalance))}</span>
            </div>
            <div className="reserve-row">
              <span>Selling liabilities (open offers)</span>
              <span className="mono">{fmtAmount(fromStroops(r.sellingLiabilities))}</span>
            </div>
            <div className="reserve-row total">
              <span>Reserved</span>
              <span className="mono">{fmtAmount(fromStroops(r.reserved))}</span>
            </div>
            <div className="reserve-row spend">
              <span>Spendable</span>
              <span className="mono">{fmtAmount(fromStroops(r.spendable))}</span>
            </div>
          </div>
          <div className="kvs">
            {priceTrace}
            {why}
            <Kv k="Buying liabilities">{fmtAmount(fromStroops(r.buyingLiabilities))} XLM</Kv>
            <Kv k="Account entry">
              last modified in ledger #{fmtInt(h.lastModifiedLedger ?? 0)} ·{' '}
              <ExtLink href={explorer.account(account)}>stellar.expert</ExtLink>
            </Kv>
          </div>
        </div>
      );
    }
    case 'credit':
      return (
        <div className="kvs kvs-2">
          <Kv k="Asset">
            <span className="mono">{h.code}</span> issued by <AccountLink id={h.issuer} head={6} tail={6} />
          </Kv>
          <Kv k="Verification (SEP-1)">{h.verification ? ('detail' in h.verification ? h.verification.detail : `listed in ${h.verification.domain} stellar.toml`) : 'checking'}</Kv>
          {priceTrace}
          {why}
          <Kv k="Trustline flags">
            {h.flags.authorized ? 'authorized' : h.flags.authorizedToMaintainLiabilities ? 'authorized to maintain liabilities' : 'not authorized'}
            {h.flags.clawbackEnabled ? ', clawback enabled' : ', no clawback'}
          </Kv>
          <Kv k="Limit">{h.limit === '922337203685.4775807' ? 'maximum' : fmtAmount(h.limit)}</Kv>
          <Kv k="Liabilities">
            buying {fmtAmountShort(h.buyingLiabilities)}, selling {fmtAmountShort(h.sellingLiabilities)}
          </Kv>
          <Kv k="Stellar Asset Contract">
            <span className="mono">{shortAddress(h.sacContractId, 6, 6)}</span> <CopyButton text={h.sacContractId} />
          </Kv>
          <Kv k="Trustline entry">last modified in ledger #{fmtInt(h.lastModifiedLedger ?? 0)}</Kv>
        </div>
      );
    case 'pool_share':
      return (
        <div className="details-grid">
          <div className="reserves">
            <div className="reserves-title">Your share of the reserves</div>
            {h.pool ? (
              h.pool.reserves.map((r) => (
                <div className="reserve-row" key={r.assetId}>
                  <span>
                    {r.code}
                    <small>pool holds {fmtAmountShort(r.poolAmount)}</small>
                  </span>
                  <span className="cell-stack right">
                    <span className="mono">{fmtAmountShort(r.amount)}</span>
                    <span className="src">
                      {r.valueUsd === null ? 'unpriced' : fmtUsd(r.valueUsd)}
                      {r.valueUsd !== null && r.depthRatio !== null ? ` at depth (spot ${fmtUsd(r.valueUsd / r.depthRatio)})` : ''}
                    </span>
                  </span>
                </div>
              ))
            ) : (
              <div className="reserve-row">{h.poolError ?? <Spinner />}</div>
            )}
          </div>
          <div className="kvs">
            {priceTrace}
            {why}
            {h.pool ? (
              <>
                <Kv k="Pool">
                  constant product, fee {h.pool.feeBp / 100}%, {fmtInt(h.pool.totalTrustlines)} participants
                </Kv>
                <Kv k="Total shares">{fmtAmountShort(h.pool.totalShares)}</Kv>
              </>
            ) : null}
            <Kv k="Pool id">
              <span className="mono">{shortAddress(h.poolId, 8, 8)}</span> <CopyButton text={h.poolId} />
            </Kv>
          </div>
        </div>
      );
    case 'sep41':
      return (
        <div className="kvs kvs-2">
          <Kv k="Contract">
            <span className="mono">{shortAddress(h.contractId, 6, 6)}</span> <CopyButton text={h.contractId} />
          </Kv>
          <Kv k="Read">balance() by simulateTransaction at ledger #{fmtInt(h.checkedAtLedger)}</Kv>
          {why}
          <Kv k="Registry sources">{h.registry.sources.join('; ')}</Kv>
        </div>
      );
  }
}

/**
 * Verify results, kept per account load (not per mount) so that switching
 * tabs neither loses a result nor re-runs an automatic check.
 */
const verifyStore = new Map<string, VerifyResult>();
const verifyKey = (account: string, asOf: number, key: string) => `${account}|${asOf}|${key}`;
/** ?verify=1 checks at most this many rows automatically (one RPC call each). */
const MAX_AUTO_VERIFY = 10;

function HoldingRow({
  h,
  account,
  asOf,
  totalUsd,
  pending,
  autoOpen,
  autoVerify,
}: {
  h: Holding;
  account: string;
  asOf: number;
  totalUsd: number;
  /** True while some holdings are still being priced: shares are not final yet. */
  pending: boolean;
  autoOpen?: boolean;
  autoVerify?: boolean;
}) {
  const storeKey = verifyKey(account, asOf, h.key);
  const [open, setOpen] = useState(!!autoOpen);
  const [verifying, setVerifying] = useState(false);
  const [result, setResult] = useState<VerifyResult | null>(() => verifyStore.get(storeKey) ?? null);
  const share = h.valuation.valueUsd !== null && totalUsd > 0 ? (h.valuation.valueUsd / totalUsd) * 100 : null;
  const verify = async () => {
    setVerifying(true);
    setOpen(true);
    const r = await verifyHolding(h, account);
    verifyStore.set(storeKey, r);
    setResult(r);
    setVerifying(false);
  };
  useEffect(() => {
    if (autoOpen && autoVerify && !verifyStore.has(storeKey)) void verify();
  }, []);
  const vTone = result ? verifyTone(result) : null;
  const detailsId = `hd-${h.key.replace(/[^A-Za-z0-9]/g, '')}`;
  return (
    <div className={`hrow ${open ? 'open' : ''}`}>
      {/* The whole row toggles on click; the chevron button is the keyboard and screen-reader control. */}
      <div className="hrow-main" onClick={() => setOpen(!open)}>
        <div className="c-asset">
          <button
            type="button"
            className="chev"
            aria-expanded={open}
            aria-controls={detailsId}
            aria-label={`${open ? 'Hide' : 'Show'} details of ${h.code}`}
            onClick={(e) => {
              e.stopPropagation();
              setOpen(!open);
            }}
          >
            <Icon name="chevron" size={14} />
          </button>
          <AssetCell h={h} />
        </div>
        <div className="c-bal">
          <BalanceCell h={h} />
        </div>
        <div className="c-price">
          <PriceCell v={h.valuation} />
        </div>
        <div className="c-value">
          <ValueCell v={h.valuation} />
        </div>
        <div className="c-share">
          {pending && h.valuation.state !== 'zero' ? (
            <Skeleton w={44} />
          ) : share !== null ? (
            <span className="share">
              <span className="mono">{fmtPct(share, share < 10 ? 2 : 1)}</span>
              <span className="share-bar">
                <span style={{ width: `${Math.max(1.5, share)}%` }} />
              </span>
            </span>
          ) : (
            <span className="muted">-</span>
          )}
        </div>
        <div className="c-verify">
          <button
            type="button"
            className={`btn btn-verify ${vTone ? `vt-${vTone}` : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              void verify();
            }}
            disabled={verifying}
            title={h.type === 'sep41' ? 'Simulate balance() again on Stellar RPC and compare' : 'Read this entry straight from Stellar RPC (getLedgerEntries) and compare'}
          >
            {verifying ? <Spinner size={11} /> : <Icon name={vTone === 'ok' ? 'check' : vTone ? 'alert' : 'shield'} size={13} />}
            <span>{result ? VERIFY_LABEL[result.status] : 'Verify'}</span>
          </button>
        </div>
      </div>
      {open ? (
        <div className="hrow-details" id={detailsId}>
          {result ? <VerifyPanel r={result} /> : null}
          <Details h={h} account={account} />
        </div>
      ) : null}
    </div>
  );
}

/** Reserve locked by empty trustlines: 1 subentry each (2 for a pool share), nothing for the account when sponsored. */
function emptyReserveNote(empty: readonly Holding[], baseReserveStroops: bigint): string {
  let locked = 0n;
  let sponsored = 0;
  for (const h of empty) {
    const sponsor = h.type === 'credit' || h.type === 'pool_share' ? h.sponsor : null;
    if (sponsor) sponsored++;
    else locked += (h.type === 'pool_share' ? 2n : 1n) * baseReserveStroops;
  }
  const parts: string[] = ['zero balance'];
  if (locked > 0n) parts.push(`${fromStroops(locked)} XLM of this account's reserve`);
  if (sponsored) parts.push(`${sponsored === empty.length ? (sponsored > 1 ? 'all' : '') : sponsored} sponsored, reserve paid by the sponsor`.trim());
  return parts.join('; ');
}

export function Holdings({ model, expand = [], autoVerify = false }: { model: PositionsModel; expand?: string[]; autoVerify?: boolean }) {
  const wants = (h: Holding) => expand.includes('ALL') || expand.includes(h.code.toUpperCase());
  const autoVerifyKeys = new Set(model.holdings.filter(wants).slice(0, MAX_AUTO_VERIFY).map((h) => h.key));
  const pending = model.summary.pending > 0;
  const [showEmpty, setShowEmpty] = useState(false);
  const account = model.account.id;
  const total = model.summary.totalValueUsd;
  const sep = model.sep41;
  const sepDone = sep.every((c) => c.state !== 'pending');
  return (
    <section className="panel">
      <div className="htable" role="table" aria-label="Holdings">
        <div className="hhead" role="row">
          <div className="c-asset">Asset</div>
          <div className="c-bal">Balance</div>
          <div className="c-price">Price</div>
          <div className="c-value">Value</div>
          <div className="c-share">Share</div>
          <div className="c-verify">Ledger</div>
        </div>
        {model.holdings.map((h) => (
          <HoldingRow
            key={h.key}
            h={h}
            account={account}
            asOf={model.asOf}
            totalUsd={total}
            pending={pending}
            autoOpen={wants(h)}
            autoVerify={autoVerify && autoVerifyKeys.has(h.key)}
          />
        ))}
      </div>

      {model.emptyTrustlines.length ? (
        <div className="empties">
          <button type="button" className="link-btn" onClick={() => setShowEmpty(!showEmpty)}>
            <Icon name="chevron" size={12} className={showEmpty ? 'rot' : ''} />
            {model.emptyTrustlines.length} empty trustline{model.emptyTrustlines.length > 1 ? 's' : ''} ({emptyReserveNote(model.emptyTrustlines, BigInt(model.ledger.base_reserve_in_stroops))})
          </button>
          {showEmpty ? (
            <div className="htable htable-empty">
              {model.emptyTrustlines.map((h) => (
                <HoldingRow key={h.key} h={h} account={account} asOf={model.asOf} totalUsd={total} pending={false} />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="sep41">
        <div className="sep41-head">
          <span className="label">SEP-41 tokens checked against a registry in this preview {sepDone ? null : <Spinner size={10} />}</span>
          <span className="sep41-note">
            Soroban token balances are read with <span className="mono">balance()</span> by simulation, for the {sep.length} registry tokens below. Our own ingestion will index every SEP-41 token.
          </span>
        </div>
        <div className="sep41-list">
          {sep.map((c) => (
            <ExtLink key={c.entry.contractId} href={explorer.contract(c.entry.contractId)} className={`sep41-item s-${c.state}`} title={`${c.entry.name}\n${c.entry.contractId}\nSources: ${c.entry.sources.join('; ')}`}>
              <span className="sep41-sym">{c.entry.symbol}</span>
              <span className="sep41-proj">{c.entry.project}</span>
              <span className="sep41-state">
                {c.state === 'pending' ? <Spinner size={10} /> : c.state === 'held' ? `${fmtAmountShort(c.balance ?? '0')} held` : c.state === 'none' ? 'none held' : 'read failed'}
              </span>
            </ExtLink>
          ))}
        </div>
      </div>
    </section>
  );
}

export function HoldingsSkeleton() {
  return (
    <section className="panel">
      <div className="htable">
        <div className="hhead">
          <div className="c-asset">Asset</div>
          <div className="c-bal">Balance</div>
          <div className="c-price">Price</div>
          <div className="c-value">Value</div>
          <div className="c-share">Share</div>
          <div className="c-verify">Ledger</div>
        </div>
        {[0, 1, 2, 3].map((i) => (
          <div className="hrow" key={i}>
            <div className="hrow-main">
              <div className="c-asset">
                <Skeleton w={180} h={14} />
              </div>
              <div className="c-bal">
                <Skeleton w={90} />
              </div>
              <div className="c-price">
                <Skeleton w={60} />
              </div>
              <div className="c-value">
                <Skeleton w={80} />
              </div>
              <div className="c-share">
                <Skeleton w={40} />
              </div>
              <div className="c-verify">
                <Skeleton w={64} h={22} />
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
