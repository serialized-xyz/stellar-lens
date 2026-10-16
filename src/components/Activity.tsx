import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { ActivityRow, AssetAmount } from '../data/activity.ts';
import { fmtAmountShort, fmtDate, fmtDateTime, timeAgo } from '../lib/format.ts';
import { AccountLink, Badge, ExtLink, Icon, Skeleton, Spinner } from './ui.tsx';
import type { IconName } from './ui.tsx';

export type Feed = 'payments' | 'operations';

/** One page as read from Horizon (the API drawer shows the last one). */
export interface FeedPage {
  rows: ActivityRow[];
  /** Cursor the page was requested with (null for the first page). */
  requestCursor: string | null;
  nextCursor: string | null;
  hasMore: boolean;
  fetchedAt: number;
}

export interface FeedState {
  rows: ActivityRow[];
  cursor: string | null;
  hasMore: boolean;
  loading: boolean;
  loaded: boolean;
  error: string | null;
  lastPage: FeedPage | null;
}

export const emptyFeed = (): FeedState => ({ rows: [], cursor: null, hasMore: false, loading: false, loaded: false, error: null, lastPage: null });

const ICON: Record<ActivityRow['kind'], IconName> = {
  received: 'in',
  sent: 'out',
  swap: 'swap',
  account_created: 'plus',
  account_funded: 'plus',
  merge_in: 'merge',
  merge_out: 'merge',
  pool_deposit: 'drop',
  pool_withdraw: 'drop',
  contract: 'code',
  other: 'op',
};

function Amt({ a, sign: s }: { a: AssetAmount; sign?: '+' | '-' }) {
  const sign = Number(a.amount) === 0 ? undefined : s;
  return (
    <span className="amt" title={`${a.amount} ${a.code}${a.issuer ? ` (issuer ${a.issuer})` : ''}`}>
      {sign ? <span className="amt-sign">{sign}</span> : null}
      <span className="mono">{fmtAmountShort(a.amount)}</span> <span className="amt-code">{a.code}</span>
    </span>
  );
}

function Amounts({ r }: { r: ActivityRow }) {
  if (r.conversion) {
    return (
      <span className={`amounts swap dir-${r.direction}`}>
        <Amt a={r.conversion.source} sign={r.direction === 'in' ? undefined : '-'} />
        <span className="swap-dst">
          <span className="swap-arrow">
            <Icon name="chevron" size={12} />
          </span>
          <Amt a={r.conversion.destination} sign={r.direction === 'out' ? undefined : '+'} />
        </span>
      </span>
    );
  }
  if (!r.debit.length && !r.credit.length) return r.kind === 'other' || r.kind === 'contract' ? null : <span className="amounts muted">{r.note ?? ''}</span>;
  if (r.direction === 'self' && r.kind === 'sent' && r.credit.length === 1)
    return (
      <span className="amounts dir-self">
        <Amt a={r.credit[0]} />
      </span>
    );
  return (
    <span className={`amounts dir-${r.direction}`}>
      {r.debit.map((a, i) => (
        <Amt key={`d${i}`} a={a} sign="-" />
      ))}
      {r.credit.map((a, i) => (
        <Amt key={`c${i}`} a={a} sign="+" />
      ))}
    </span>
  );
}

function Memo({ r }: { r: ActivityRow }) {
  if (!r.memo || r.memo.value === '') return null;
  const v = r.memo.type === 'hash' || r.memo.type === 'return' ? `${r.memo.value.slice(0, 10)}...` : r.memo.value;
  return (
    <span className="memo" title={`memo ${r.memo.type}: ${r.memo.value}`}>
      <span className="memo-k">memo {r.memo.type}</span>
      <span className="memo-v">{v}</span>
    </span>
  );
}

function supplyEvent(r: ActivityRow): string | null {
  const e = [...r.debit, ...r.credit].find((a) => a.event)?.event;
  return e ?? null;
}

function Counterparty({ r, account }: { r: ActivityRow; account: string }) {
  const parts: ReactNode[] = [];
  if (r.counterparty) {
    const prep =
      r.kind === 'other'
        ? 'by'
        : r.kind === 'swap' && r.direction === 'self'
          ? 'with'
          : r.direction === 'in'
            ? 'from'
            : r.direction === 'out'
              ? r.kind === 'merge_out'
                ? 'into'
                : 'to'
              : 'with';
    parts.push(
      <span key="cp">
        {prep} <AccountLink id={r.counterparty} self={account} />
        {supplyEvent(r) === 'mint' || supplyEvent(r) === 'burn' ? <span className="muted"> (the issuer)</span> : null}
      </span>,
    );
  }
  if (r.conversion && r.conversion.path.length)
    parts.push(
      <span key="path" className="path" title="Intermediate assets of the path payment">
        via {r.conversion.path.join(' > ')}
      </span>,
    );
  if (r.fromMuxedId || r.toMuxedId)
    parts.push(
      <span key="mux" className="mux" title="Muxed account ids (CAP-27) of the sender and the recipient">
        {r.fromMuxedId ? `from muxed id ${r.fromMuxedId}` : ''}
        {r.fromMuxedId && r.toMuxedId ? ', ' : ''}
        {r.toMuxedId ? `to muxed id ${r.toMuxedId}` : ''}
      </span>,
    );
  if ((r.kind === 'other' || r.kind === 'contract' || r.kind === 'swap' || r.kind === 'merge_in' || r.kind === 'merge_out') && r.note)
    parts.push(
      <span key="note" className={r.kind === 'contract' || r.kind === 'swap' ? 'mono call' : ''}>
        {r.note}
      </span>,
    );
  return <span className="arow-sub">{parts}</span>;
}

/** Re-renders every 30 s so relative times ("2m ago") stay true while the page is open. */
function useNow(periodMs = 30_000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), periodMs);
    return () => clearInterval(t);
  }, [periodMs]);
  return now;
}

export function ActivityList(props: {
  account: string;
  /** Muxed id of the address typed (M...), to highlight its rows. */
  muxedId: string | null;
  feed: Feed;
  state: FeedState;
  /** Earliest instant Horizon serves history for (unix ms), when known. */
  historyFrom: number | null;
  onFeed: (f: Feed) => void;
  onMore: () => void;
}) {
  const { state, account } = props;
  const now = useNow();
  const hit = (r: ActivityRow) => props.muxedId !== null && (r.fromMuxedId === props.muxedId || r.toMuxedId === props.muxedId);
  return (
    <section className="panel">
      <div className="feed-bar">
        <div className="seg" role="tablist" aria-label="Activity feed">
          <button type="button" role="tab" aria-selected={props.feed === 'payments'} className={props.feed === 'payments' ? 'on' : ''} onClick={() => props.onFeed('payments')}>
            Payments
          </button>
          <button type="button" role="tab" aria-selected={props.feed === 'operations'} className={props.feed === 'operations' ? 'on' : ''} onClick={() => props.onFeed('operations')}>
            All operations
          </button>
        </div>
        <span className="feed-note">
          {props.feed === 'payments'
            ? 'Payments, path payments and contract swaps (one row each), account creation and merges, SAC transfers. Source: Horizon /payments.'
            : 'Every operation, including CAP-38 pool deposits and withdrawals. Source: Horizon /operations.'}
        </span>
      </div>

      {props.muxedId ? (
        <div className="mux-note">
          Showing the base account's history. Operations to or from muxed id <span className="mono strong">{props.muxedId}</span> are highlighted, and a payment
          between two muxed ids of this account reads in or out relative to it.
        </div>
      ) : null}
      {state.error && !state.rows.length ? <div className="error-box">Could not load activity: {state.error}</div> : null}

      <div className="alist">
        {state.rows.map((r) => {
          const ev = supplyEvent(r);
          return (
            <div className={`arow k-${r.kind} ${hit(r) ? 'mux-hit' : ''}`} key={r.id}>
              <span className={`aicon dir-${r.direction}`}>
                <Icon name={r.kind === 'sent' && r.direction === 'self' ? 'refresh' : ICON[r.kind]} size={15} />
              </span>
              <div className="arow-body">
                <span className="arow-title">
                  <span>{r.title}</span>
                  {ev ? (
                    <Badge tone="muted" title={ev === 'mint' ? 'Supply created by the issuer' : ev === 'burn' ? 'Supply destroyed: sent back to the issuer' : 'Clawed back by the issuer'}>
                      {ev}
                    </Badge>
                  ) : null}
                  <span className="optype mono">{r.operationType}</span>
                </span>
                <Counterparty r={r} account={account} />
              </div>
              <div className="arow-amounts">
                <Amounts r={r} />
                <Memo r={r} />
              </div>
              <div className="arow-meta">
                <span className="when" title={fmtDateTime(r.at)}>
                  {timeAgo(r.at, now)}
                </span>
                <ExtLink href={r.explorerUrl} className="icon-link" title={`Operation ${r.id} on stellar.expert (tx ${r.txHash})`}>
                  <Icon name="ext" size={13} />
                </ExtLink>
              </div>
            </div>
          );
        })}
        {state.loading && !state.rows.length
          ? [0, 1, 2, 3, 4, 5].map((i) => (
              <div className="arow" key={`s${i}`}>
                <span className="aicon" />
                <div className="arow-body">
                  <Skeleton w={140} h={13} />
                  <Skeleton w={200} h={10} />
                </div>
                <div className="arow-amounts">
                  <Skeleton w={120} h={13} />
                </div>
                <div className="arow-meta">
                  <Skeleton w={50} h={10} />
                </div>
              </div>
            ))
          : null}
        {state.loaded && !state.rows.length && !state.error ? <div className="empty-box">No {props.feed} on this account yet.</div> : null}
      </div>

      <div className="feed-foot">
        <span className="muted">
          {state.rows.length} {props.feed === 'payments' ? 'payments' : 'operations'} loaded, newest first
        </span>
        {state.hasMore ? (
          <button type="button" className="btn btn-ghost btn-sm" onClick={props.onMore} disabled={state.loading}>
            {state.loading ? <Spinner size={11} /> : null}
            Load 50 more
          </button>
        ) : state.loaded ? (
          <span className="muted">No more records on Horizon{props.historyFrom !== null ? ` (history kept from ${fmtDate(props.historyFrom)})` : ''}</span>
        ) : null}
        {state.error && state.rows.length ? <span className="err-inline">{state.error}</span> : null}
      </div>
    </section>
  );
}
