import { useEffect, useState } from 'react';
import wordmark from '../assets/img/serialized-wordmark-light.svg';
import { LIMITS, explorer } from '../data/config.ts';
import { getLatestLedger } from '../data/horizon.ts';
import { describeError } from '../data/http.ts';
import { getHealth } from '../data/rpc.ts';
import { fmtInt } from '../lib/format.ts';
import type { Connected } from '../lib/wallet.ts';
import { Icon, StellarMark, Spinner } from './ui.tsx';
import { shortAddress } from '../data/stellar.ts';

interface Tick {
  seq: number;
  closedAt: number;
  source: string;
}

/** Latest ledger: RPC getHealth (sequence + close time), Horizon as fallback. Polled at most every 5 s, only while the tab is visible. */
function useLedgerTicker() {
  const [tick, setTick] = useState<Tick | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const poll = async () => {
      if (document.visibilityState === 'visible') {
        try {
          const { result, endpoint } = await getHealth();
          const close = Number(result.latestLedgerCloseTime);
          if (Number.isFinite(close) && close > 0) {
            setTick({ seq: result.latestLedger, closedAt: close * 1000, source: `Stellar RPC getHealth (${new URL(endpoint).host})` });
          } else {
            const l = await getLatestLedger();
            setTick({ seq: l.sequence, closedAt: Date.parse(l.closed_at), source: 'Horizon /ledgers' });
          }
          setError(null);
          failures = 0;
        } catch (rpcErr) {
          try {
            const l = await getLatestLedger();
            setTick({ seq: l.sequence, closedAt: Date.parse(l.closed_at), source: 'Horizon /ledgers (RPC unavailable)' });
            setError(null);
            failures = 0;
          } catch (err) {
            failures++;
            setError(`${describeError(rpcErr)}; Horizon: ${describeError(err)}`);
          }
        }
      }
      // Back off after failures: 5 s, 10 s, 20 s, up to 60 s.
      const delay = Math.min(60_000, LIMITS.tickerMs * 2 ** Math.min(failures, 4));
      if (!stopped) timer = setTimeout(poll, delay);
    };
    void poll();
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      clearInterval(clock);
    };
  }, []);

  return { tick, error, now };
}

export function LedgerTicker() {
  const { tick, error, now } = useLedgerTicker();
  if (!tick)
    return (
      <div className={`ticker ${error ? 'ticker-bad' : ''}`} title={error ?? 'Reading the latest ledger'}>
        <span className="ticker-dot" />
        <span className="ticker-net">Stellar mainnet</span>
        <span className="ticker-sep" />
        {error ? <span>ledger unavailable</span> : <Spinner size={10} />}
      </div>
    );
  const ago = Math.max(0, Math.round((now - tick.closedAt) / 1000));
  const stale = ago > 30;
  return (
    <a
      className={`ticker ${stale || error ? 'ticker-warn' : ''}`}
      href={explorer.ledger(tick.seq)}
      target="_blank"
      rel="noopener noreferrer"
      title={`${tick.source}${error ? `. Last poll failed: ${error}` : ''}`}
    >
      <span className="ticker-dot" />
      <span className="ticker-net">Stellar mainnet</span>
      <span className="ticker-sep" />
      <span className="ticker-ledger">
        <span className="ticker-label">ledger</span> #{fmtInt(tick.seq)}
      </span>
      <span className="ticker-sep" />
      <span className="ticker-ago">closed {ago}s ago</span>
    </a>
  );
}

export function Header(props: {
  wallet: Connected | null;
  connecting: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  onHome: () => void;
}) {
  return (
    <header className="topbar">
      <div className="topbar-inner">
        <a
          className="brand"
          href="./"
          onClick={(e) => {
            e.preventDefault();
            props.onHome();
          }}
        >
          <img className="brand-wordmark" src={wordmark} alt="Serialized" width={103} height={18} />
          <span className="brand-x" aria-hidden="true">
            ×
          </span>
          <StellarMark size={17} className="brand-stellar" />
          <span className="brand-divider" aria-hidden="true" />
          <span className="brand-title">Stellar Lens</span>
          <span className="preview-badge">Preview</span>
        </a>
        <div className="topbar-right">
          <LedgerTicker />
          {props.wallet ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm wallet-chip"
              onClick={props.onDisconnect}
              title={`Connected: ${props.wallet.address}${props.wallet.walletName ? ` (${props.wallet.walletName})` : ''}. Click to disconnect (read-only session).`}
              aria-label="Disconnect wallet"
            >
              <span className="wallet-dot" />
              <span className="mono wallet-addr">{shortAddress(props.wallet.address)}</span>
              {props.wallet.walletName ? <span className="wallet-name">{props.wallet.walletName}</span> : null}
              <Icon name="close" size={12} />
            </button>
          ) : (
            <button type="button" className="btn btn-primary btn-sm btn-connect" onClick={props.onConnect} disabled={props.connecting} aria-label="Connect wallet" title="Connect a Stellar wallet (read-only)">
              {props.connecting ? <Spinner size={12} /> : <Icon name="wallet" size={14} />}
              <span className="connect-label">Connect wallet</span>
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
