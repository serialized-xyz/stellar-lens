// Display formatting (UI only; the data layer keeps exact strings and bigints).

const usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const usd2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const int = new Intl.NumberFormat('en-US');

export function fmtUsd(v: number | null | undefined, opts: { compact?: boolean } = {}): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return 'unpriced';
  if (v === 0) return '$0.00';
  if (opts.compact && Math.abs(v) >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (Math.abs(v) >= 100_000) return usd0.format(v);
  if (Math.abs(v) < 0.01) return '< $0.01';
  return usd2.format(v);
}

/** Unit price: more precision for small prices. */
export function fmtPriceUsd(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return 'unpriced';
  if (v >= 1) return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
  if (v >= 1e-9) return `$${v.toLocaleString('en-US', { maximumSignificantDigits: 4, minimumSignificantDigits: 4 })}`;
  return `$${v.toExponential(3)}`;
}

/** Decimal string amount with thousands separators, exact digits kept (up to `maxFrac`). */
export function fmtAmount(amount: string, maxFrac = 7): string {
  const neg = amount.startsWith('-');
  const [i, f = ''] = (neg ? amount.slice(1) : amount).split('.');
  const intPart = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = f.slice(0, maxFrac).replace(/0+$/, '');
  return `${neg ? '-' : ''}${intPart}${frac ? `.${frac}` : ''}`;
}

/** Compact amount for dense lists: 2 decimals above 1, more below. */
export function fmtAmountShort(amount: string): string {
  const n = Number(amount);
  if (!Number.isFinite(n)) return amount;
  if (Math.abs(n) >= 1000) return fmtAmount(amount, 2);
  if (Math.abs(n) >= 1) return fmtAmount(amount, 4);
  return fmtAmount(amount, 7);
}

export function fmtInt(n: number): string {
  return int.format(n);
}

export function fmtPct(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '';
  if (n > 0 && n < 0.01) return '< 0.01%';
  return `${n.toFixed(digits)}%`;
}

export function timeAgo(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 60) return `${d}d ago`;
  return new Date(ms).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

export function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function fmtDateTime(ms: number): string {
  return new Date(ms).toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
  });
}
