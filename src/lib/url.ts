// Shareable state in the query string: ?address=G...&tab=activity&api=1&endpoint=transfers&feed=operations

export type Tab = 'holdings' | 'activity';
type Endpoint = 'positions' | 'transfers' | 'swaps';
type Feed = 'payments' | 'operations';

export interface UrlState {
  address: string | null;
  tab: Tab;
  api: boolean;
  endpoint: Endpoint;
  feed: Feed;
  /** ?connect=1 opens the wallet picker on load (read only on load, never written back). */
  connect?: boolean;
  /** ?expand=XLM,EURC (or all) opens those holding rows; ?verify=1 runs Verify on them. Read only on load. */
  expand?: string[];
  verify?: boolean;
}

const pick = <T extends string>(v: string | null, allowed: readonly T[], fallback: T): T =>
  v !== null && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;

export function readUrlState(): UrlState {
  const q = new URLSearchParams(window.location.search);
  return {
    address: q.get('address')?.trim() || null,
    tab: pick(q.get('tab'), ['holdings', 'activity'] as const, 'holdings'),
    api: q.get('api') === '1',
    endpoint: pick(q.get('endpoint'), ['positions', 'transfers', 'swaps'] as const, 'positions'),
    feed: pick(q.get('feed'), ['payments', 'operations'] as const, 'payments'),
    connect: q.get('connect') === '1',
    expand: (q.get('expand') ?? '')
      .split(',')
      .map((x) => x.trim().toUpperCase())
      .filter(Boolean),
    verify: q.get('verify') === '1',
  };
}

export function writeUrlState(s: UrlState): void {
  const q = new URLSearchParams();
  if (s.address) q.set('address', s.address);
  if (s.address && s.tab !== 'holdings') q.set('tab', s.tab);
  if (s.address && s.feed !== 'payments') q.set('feed', s.feed);
  if (s.address && s.api) q.set('api', '1');
  if (s.address && s.api && s.endpoint !== 'positions') q.set('endpoint', s.endpoint);
  const search = q.toString();
  const url = `${window.location.pathname}${search ? `?${search}` : ''}${window.location.hash}`;
  if (url !== `${window.location.pathname}${window.location.search}${window.location.hash}`) window.history.replaceState(null, '', url);
}
