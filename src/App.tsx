import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { loadOperations, loadPayments } from './data/activity.ts';
import { positionsJson, positionsPath, swapsJson, swapsPath, transfersJson, transfersPath } from './data/api.ts';
import { DEMO_ACCOUNT, EXAMPLE_ACCOUNTS, SEP41_REGISTRY, explorer } from './data/config.ts';
import { fromStroops } from './data/amount.ts';
import { describeError, invalidate } from './data/http.ts';
import { AccountNotFoundError, loadPositions } from './data/positions.ts';
import type { PositionsModel } from './data/positions.ts';
import { parseAddress } from './data/stellar.ts';
import type { ParsedAddress } from './data/stellar.ts';
import { fmtAmountShort, fmtInt, fmtUsd } from './lib/format.ts';
import { readUrlState, writeUrlState } from './lib/url.ts';
import type { Tab } from './lib/url.ts';
import { connectWallet, disconnectWallet } from './lib/wallet.ts';
import type { Connected } from './lib/wallet.ts';
import { ActivityList, emptyFeed } from './components/Activity.tsx';
import type { Feed, FeedState } from './components/Activity.tsx';
import { ApiDrawer } from './components/ApiDrawer.tsx';
import type { Endpoint, EndpointView } from './components/ApiDrawer.tsx';
import { Header } from './components/Header.tsx';
import { Holdings, HoldingsSkeleton } from './components/Holdings.tsx';
import { Badge, CopyButton, ExtLink, Icon, Skeleton, Spinner } from './components/ui.tsx';

type PositionsState =
  | { status: 'idle' }
  | { status: 'loading'; model: PositionsModel | null }
  | { status: 'ready'; model: PositionsModel }
  | { status: 'error'; error: string; notFound: boolean };

const KNOWN_LABELS: Record<string, { label: string; source: string }> = {
  [DEMO_ACCOUNT.address]: { label: `${DEMO_ACCOUNT.label} (demo)`, source: DEMO_ACCOUNT.source },
  ...Object.fromEntries(EXAMPLE_ACCOUNTS.map((e) => [e.address, { label: e.label, source: e.source }])),
};

export function App() {
  const initial = useMemo(() => readUrlState(), []);
  const [query, setQuery] = useState(initial.address ?? '');
  const [inputError, setInputError] = useState<string | null>(null);
  const [target, setTarget] = useState<ParsedAddress | null>(() => {
    if (!initial.address) return null;
    const p = parseAddress(initial.address);
    return p.ok ? p.value : null;
  });
  const [tab, setTab] = useState<Tab>(initial.tab);
  const [feed, setFeed] = useState<Feed>(initial.feed);
  const [apiOpen, setApiOpen] = useState(initial.api);
  const [endpoint, setEndpoint] = useState<Endpoint>(initial.endpoint);
  const [positions, setPositions] = useState<PositionsState>({ status: 'idle' });
  const [feeds, setFeeds] = useState<Record<Feed, FeedState>>({ payments: emptyFeed(), operations: emptyFeed() });
  const [wallet, setWallet] = useState<Connected | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const loadId = useRef(0);

  useEffect(() => {
    if (initial.address && !target) {
      const p = parseAddress(initial.address);
      if (!p.ok) setInputError(p.error);
    }
    if (initial.connect) void connect();
  }, []);

  // Keep the URL shareable.
  useEffect(() => {
    writeUrlState({ address: target?.input ?? null, tab, api: apiOpen, endpoint, feed });
  }, [target, tab, apiOpen, endpoint, feed]);

  // Holdings + first page of payments whenever the account changes.
  useEffect(() => {
    if (!target) {
      setPositions({ status: 'idle' });
      return;
    }
    const id = ++loadId.current;
    setPositions({ status: 'loading', model: null });
    setFeeds({ payments: { ...emptyFeed(), loading: true }, operations: emptyFeed() });
    loadPositions(target, {
      onUpdate: (m) => {
        if (loadId.current === id) setPositions(m.complete ? { status: 'ready', model: m } : { status: 'loading', model: m });
      },
    })
      .then((m) => {
        if (loadId.current === id) setPositions({ status: 'ready', model: m });
      })
      .catch((err) => {
        if (loadId.current === id)
          setPositions({ status: 'error', error: err instanceof Error ? err.message : describeError(err), notFound: err instanceof AccountNotFoundError });
      });
    loadPayments(target.account)
      .then((p) => {
        if (loadId.current === id)
          setFeeds((f) => ({ ...f, payments: { rows: p.rows, cursor: p.nextCursor, hasMore: p.hasMore, loading: false, loaded: true, error: null } }));
      })
      .catch((err) => {
        if (loadId.current === id) setFeeds((f) => ({ ...f, payments: { ...f.payments, loading: false, loaded: true, error: describeError(err) } }));
      });
  }, [target, reloadKey]);

  const loadFeed = useCallback(
    (which: Feed, more: boolean) => {
      if (!target) return;
      const id = loadId.current;
      const current = feeds[which];
      if (current.loading) return;
      setFeeds((f) => ({ ...f, [which]: { ...f[which], loading: true, error: null } }));
      const fn = which === 'payments' ? loadPayments : loadOperations;
      fn(target.account, more ? current.cursor : null)
        .then((p) => {
          if (loadId.current !== id) return;
          setFeeds((f) => ({
            ...f,
            [which]: {
              rows: more ? [...f[which].rows, ...p.rows] : p.rows,
              cursor: p.nextCursor,
              hasMore: p.hasMore,
              loading: false,
              loaded: true,
              error: null,
            },
          }));
        })
        .catch((err) => {
          if (loadId.current === id) setFeeds((f) => ({ ...f, [which]: { ...f[which], loading: false, loaded: true, error: describeError(err) } }));
        });
    },
    [target, feeds],
  );

  useEffect(() => {
    if (target && tab === 'activity' && feed === 'operations' && !feeds.operations.loaded && !feeds.operations.loading) loadFeed('operations', false);
  }, [target, tab, feed, feeds.operations.loaded, feeds.operations.loading]);

  const lookUp = (raw: string) => {
    const p = parseAddress(raw);
    if (!p.ok) {
      setInputError(p.error);
      return;
    }
    setInputError(null);
    setQuery(p.value.input);
    if (target && target.input === p.value.input) setReloadKey((k) => k + 1);
    else setTarget(p.value);
  };

  const goHome = () => {
    setTarget(null);
    setQuery('');
    setApiOpen(false);
    setInputError(null);
  };

  const connect = async () => {
    setConnecting(true);
    setWalletError(null);
    try {
      const w = await connectWallet();
      setWallet(w);
      lookUp(w.address);
    } catch (err) {
      const msg = describeError(err);
      // Closing the modal is not an error worth showing.
      if (!/clos|cancel|dismiss|reject/i.test(msg)) setWalletError(`Wallet connection failed: ${msg}`);
    } finally {
      setConnecting(false);
    }
  };

  const disconnect = async () => {
    await disconnectWallet().catch(() => undefined);
    setWallet(null);
  };

  const refresh = () => {
    if (!target) return;
    invalidate(target.account);
    setReloadKey((k) => k + 1);
  };

  const model = positions.status === 'ready' || positions.status === 'loading' ? positions.model : null;
  const asOf = model?.asOf ?? Date.now();

  const views: EndpointView[] = useMemo(() => {
    const wallet = target?.account ?? 'G...';
    const pay = feeds.payments;
    const page = { hasMore: pay.hasMore, nextCursor: pay.cursor };
    return [
      {
        id: 'positions',
        label: '/v1/wallet/positions',
        path: positionsPath(wallet),
        json: model?.complete ? positionsJson(model) : null,
        ready: !!model?.complete,
        note: 'Same envelope and row fields as on EVM and Solana. Trade-derived fields (entry, exit, PnL, buys, sells) are null in this preview: they come from our own ingestion. Stellar specifics sit under "stellar".',
      },
      {
        id: 'transfers',
        label: '/v1/wallet/transfers',
        path: transfersPath(wallet),
        json: pay.loaded && !pay.error ? transfersJson(pay.rows, page, asOf) : null,
        ready: pay.loaded && !pay.error,
        note: 'Token movements in and out, newest first, one row per asset moved. amountUsd is only filled for Circle USDC (face value): historical prices come with our own ingestion. A path payment to another account is a transfer carrying stellar.conversion.',
      },
      {
        id: 'swaps',
        label: '/v1/wallet/swaps',
        path: swapsPath(wallet),
        json: pay.loaded && !pay.error ? swapsJson(pay.rows, page, asOf) : null,
        ready: pay.loaded && !pay.error,
        note: 'The account\'s own path payments (source and destination both this account), one row per transaction. route is null: per-hop venues are read from trade effects by our own ingestion.',
      },
    ];
  }, [target, model, feeds.payments, asOf]);

  return (
    <div className="app">
      <Header wallet={wallet} connecting={connecting} onConnect={() => void connect()} onDisconnect={() => void disconnect()} onHome={goHome} />
      {walletError ? (
        <div className="banner banner-bad">
          <Icon name="alert" size={14} /> {walletError}
          <button type="button" className="icon-btn" onClick={() => setWalletError(null)} aria-label="Dismiss">
            <Icon name="close" size={13} />
          </button>
        </div>
      ) : null}

      <main className="main">
        {!target ? (
          <Hero query={query} setQuery={setQuery} error={inputError} onLookUp={lookUp} onDemo={() => lookUp(DEMO_ACCOUNT.address)} onConnect={() => void connect()} connecting={connecting} />
        ) : (
          <>
            <SearchStrip query={query} setQuery={setQuery} error={inputError} onLookUp={lookUp} onDemo={() => lookUp(DEMO_ACCOUNT.address)} />
            <AccountHeader target={target} positions={positions} wallet={wallet} onRefresh={refresh} />
            {positions.status === 'error' ? (
              <div className="error-box big">
                <Icon name="alert" size={16} /> {positions.error}
                {positions.notFound ? (
                  <span className="muted"> An address only exists on the ledger once it has received at least 1 XLM.</span>
                ) : (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={refresh}>
                    Retry
                  </button>
                )}
              </div>
            ) : (
              <>
                <div className="tabs-bar">
                  <div className="tabs" role="tablist">
                    <button type="button" role="tab" className={tab === 'holdings' ? 'on' : ''} onClick={() => setTab('holdings')}>
                      Holdings
                      {model ? <span className="count">{model.holdings.length}</span> : null}
                    </button>
                    <button type="button" role="tab" className={tab === 'activity' ? 'on' : ''} onClick={() => setTab('activity')}>
                      Activity
                      {feeds.payments.loaded ? <span className="count">{feeds.payments.rows.length}{feeds.payments.hasMore ? '+' : ''}</span> : null}
                    </button>
                  </div>
                  <button type="button" className="btn btn-api" onClick={() => setApiOpen(true)}>
                    <Icon name="braces" size={14} />
                    <span>API JSON</span>
                  </button>
                </div>
                {tab === 'holdings' ? (
                  model ? (
                    <Holdings model={model} expand={initial.expand} autoVerify={initial.verify} />
                  ) : (
                    <HoldingsSkeleton />
                  )
                ) : (
                  <ActivityList
                    account={target.account}
                    muxedId={target.muxedId}
                    feed={feed}
                    state={feeds[feed]}
                    onFeed={(f) => setFeed(f)}
                    onMore={() => loadFeed(feed, true)}
                  />
                )}
              </>
            )}
          </>
        )}
      </main>

      <Footer />
      <ApiDrawer open={apiOpen && !!target} views={views} active={endpoint} onSelect={setEndpoint} onClose={() => setApiOpen(false)} />
    </div>
  );
}

function SearchForm(props: { query: string; setQuery: (s: string) => void; onLookUp: (s: string) => void; big?: boolean }) {
  return (
    <form
      className={`search ${props.big ? 'search-big' : ''}`}
      onSubmit={(e) => {
        e.preventDefault();
        props.onLookUp(props.query);
      }}
    >
      <Icon name="search" size={props.big ? 18 : 15} className="search-icon" />
      <input
        className="search-input mono"
        value={props.query}
        onChange={(e) => props.setQuery(e.target.value)}
        placeholder="Stellar address: G... or muxed M..."
        spellcheck={false}
        autoComplete="off"
        autoCapitalize="characters"
        aria-label="Stellar account address"
      />
      <button type="submit" className="btn btn-primary">
        Look up
      </button>
    </form>
  );
}

function Hero(props: {
  query: string;
  setQuery: (s: string) => void;
  error: string | null;
  onLookUp: (s: string) => void;
  onDemo: () => void;
  onConnect: () => void;
  connecting: boolean;
}) {
  return (
    <div className="hero">
      <div className="hero-eyebrow">
        <span>Serialized Data API</span>
        <span className="dotsep" />
        <span>Stellar preview</span>
      </div>
      <h1 className="hero-title">
        Any Stellar account,{' '}
        <br />
        in the shapes of our API.
      </h1>
      <p className="hero-sub">
        Holdings with XLM reserves, trustlines, pool shares and USD values, plus payment history, read live from Stellar mainnet and shown in the JSON
        shapes our wallet endpoints already serve on 18 EVM chains and Solana. Every balance can be checked against the ledger.
      </p>
      <div className="hero-card">
        <SearchForm query={props.query} setQuery={props.setQuery} onLookUp={props.onLookUp} big />
        {props.error ? <div className="input-error">{props.error}</div> : null}
        <div className="hero-actions">
          <button type="button" className="btn btn-ghost" onClick={props.onDemo}>
            <Icon name="chevron" size={14} />
            Try a demo account
          </button>
          <button type="button" className="btn btn-ghost" onClick={props.onConnect} disabled={props.connecting}>
            {props.connecting ? <Spinner size={12} /> : <Icon name="wallet" size={14} />}
            Connect Freighter, xBull or another wallet
          </button>
        </div>
        <div className="examples">
          <span className="label">Also try</span>
          {EXAMPLE_ACCOUNTS.map((e) => (
            <button key={e.address} type="button" className="link-btn example" onClick={() => props.onLookUp(e.address)} title={e.source}>
              <span className="strong">{e.label}</span>
              <span className="muted">{e.why}</span>
            </button>
          ))}
        </div>
        <div className="hero-fine">
          <Icon name="shield" size={13} />
          Read-only. Lens only reads your public key from the wallet and never asks you to sign anything.
        </div>
      </div>

      <div className="features">
        <div className="feature">
          <div className="feature-k">Holdings</div>
          <div className="feature-t">/v1/wallet/positions</div>
          <p>XLM with minimum balance, liabilities and spendable amount; every trustline with issuer, SEP-1 verification and flags; CAP-38 pool shares split into reserves; SEP-41 tokens.</p>
        </div>
        <div className="feature">
          <div className="feature-k">Prices</div>
          <div className="feature-t">SDEX and classic pools</div>
          <p>XLM from the SDEX order book against Circle USDC, other assets through strict-send paths. A price that fails a sanity check shows as unpriced, with the reason.</p>
        </div>
        <div className="feature">
          <div className="feature-k">Activity</div>
          <div className="feature-t">/v1/wallet/transfers, /swaps</div>
          <p>Payments, path payments as one swap row, account creation and merges, pool deposits and withdrawals, memos, with cursor pagination.</p>
        </div>
        <div className="feature">
          <div className="feature-k">Verify</div>
          <div className="feature-t">Stellar RPC getLedgerEntries</div>
          <p>One click reads the account or trustline entry straight from the ledger and shows whether it matches what the page displays.</p>
        </div>
      </div>
    </div>
  );
}

function SearchStrip(props: { query: string; setQuery: (s: string) => void; error: string | null; onLookUp: (s: string) => void; onDemo: () => void }) {
  return (
    <div className="strip">
      <SearchForm query={props.query} setQuery={props.setQuery} onLookUp={props.onLookUp} />
      <button type="button" className="btn btn-ghost btn-demo" onClick={props.onDemo}>
        Demo account
      </button>
      {props.error ? <div className="input-error">{props.error}</div> : null}
    </div>
  );
}

function Kpi({ label, children, sub }: { label: string; children: ReactNode; sub?: ReactNode }) {
  return (
    <div className="kpi">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{children}</div>
      {sub ? <div className="kpi-sub">{sub}</div> : null}
    </div>
  );
}

function AccountHeader(props: { target: ParsedAddress; positions: PositionsState; wallet: Connected | null; onRefresh: () => void }) {
  const { target, positions } = props;
  const m = positions.status === 'ready' || positions.status === 'loading' ? positions.model : null;
  const native = m?.holdings.find((h) => h.type === 'native');
  const reserves = native && native.type === 'native' ? native.reserves : null;
  const label = KNOWN_LABELS[target.account];
  const loading = positions.status === 'loading';
  return (
    <section className="account">
      <div className="account-top">
        <div className="account-id">
          <div className="label">
            Account
            {label ? (
              <Badge tone="accent" title={label.source}>
                {label.label}
              </Badge>
            ) : null}
            {props.wallet && props.wallet.address === target.account ? <Badge tone="ok">connected wallet</Badge> : null}
          </div>
          <div className="account-addr">
            <span className="mono">{target.account}</span>
            <CopyButton text={target.account} />
            <ExtLink href={explorer.account(target.account)} className="icon-link" title="Open on stellar.expert">
              <Icon name="ext" size={14} />
            </ExtLink>
          </div>
          {target.muxedId ? (
            <div className="muxed">
              <Badge tone="accent">muxed</Badge>
              <span className="mono">{target.input.slice(0, 10)}...{target.input.slice(-6)}</span> resolves to the base account above with muxed id{' '}
              <span className="mono strong">{target.muxedId}</span>
            </div>
          ) : null}
          {m?.account.home_domain ? (
            <div className="muxed">
              home domain <span className="mono">{m.account.home_domain}</span>
            </div>
          ) : null}
        </div>
        <div className="account-actions">
          <span className="asof">
            {m ? (
              <>
                read at ledger{' '}
                <ExtLink href={explorer.ledger(m.ledger.sequence)} className="mono">
                  #{fmtInt(m.ledger.sequence)}
                </ExtLink>
              </>
            ) : (
              <Skeleton w={120} h={10} />
            )}
          </span>
          <button type="button" className="icon-btn" onClick={props.onRefresh} title="Re-read the account" disabled={loading}>
            {loading ? <Spinner size={13} /> : <Icon name="refresh" size={15} />}
          </button>
        </div>
      </div>
      <div className="kpis">
        <Kpi
          label="Portfolio value"
          sub={
            m ? (
              m.summary.pending ? (
                <>
                  pricing {m.summary.pending} holding{m.summary.pending > 1 ? 's' : ''} <Spinner size={9} />
                </>
              ) : (
                `${m.summary.valued} of ${m.summary.positions} holdings priced${m.summary.unpriced ? `, ${m.summary.unpriced} unpriced (not counted)` : ''}`
              )
            ) : null
          }
        >
          {m && !m.summary.pending ? <span className="big">{fmtUsd(m.summary.totalValueUsd)}</span> : <Skeleton w={160} h={30} />}
        </Kpi>
        <Kpi label="XLM balance" sub={m && native?.valuation.valueUsd ? fmtUsd(native.valuation.valueUsd) : null}>
          {reserves ? <span className="mono">{fmtAmountShort(fromStroops(reserves.total))}</span> : <Skeleton w={110} h={18} />}
        </Kpi>
        <Kpi label="Reserved" sub={reserves ? `${reserves.subentryCount} subentries${reserves.numSponsoring ? `, sponsoring ${fmtInt(reserves.numSponsoring)}` : ''}${reserves.numSponsored ? `, ${reserves.numSponsored} sponsored` : ''}` : null}>
          {reserves ? <span className="mono">{fmtAmountShort(fromStroops(reserves.reserved))}</span> : <Skeleton w={80} h={18} />}
        </Kpi>
        <Kpi label="Spendable XLM">{reserves ? <span className="mono">{fmtAmountShort(fromStroops(reserves.spendable))}</span> : <Skeleton w={110} h={18} />}</Kpi>
        <Kpi label="Trustlines" sub={m ? `${m.emptyTrustlines.length} empty, ${SEP41_REGISTRY.length} SEP-41 checked` : null}>
          {m ? <span className="mono">{m.holdings.filter((h) => h.type === 'credit' || h.type === 'pool_share').length + m.emptyTrustlines.length}</span> : <Skeleton w={30} h={18} />}
        </Kpi>
      </div>
      {m?.errors.length
        ? m.errors.map((e) => (
            <div className="banner banner-warn" key={e}>
              <Icon name="alert" size={14} /> {e}
            </div>
          ))
        : null}
      {m?.xlm && !m.xlm.ok ? (
        <div className="banner banner-warn">
          <Icon name="alert" size={14} /> XLM is unpriced: {m.xlm.reason}. Assets valued through XLM are unpriced too.
        </div>
      ) : null}
    </section>
  );
}

function Footer() {
  return (
    <footer className="footer">
      <div className="footer-inner">
        <p className="footer-main">
          Preview. Reads public Stellar infrastructure (Horizon, Stellar RPC). The production version will run on Serialized's own Stellar ingestion.
        </p>
        <div className="footer-links">
          <ExtLink href="https://serialized.xyz">serialized.xyz</ExtLink>
          <ExtLink href="https://docs.serialized.xyz">docs.serialized.xyz</ExtLink>
          <ExtLink href="https://stellar.expert">Explorer links: stellar.expert</ExtLink>
        </div>
      </div>
    </footer>
  );
}
