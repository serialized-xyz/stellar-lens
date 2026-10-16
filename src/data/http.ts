// Small HTTP layer shared by the browser and node: in-memory response cache,
// in-flight de-duplication, per-host concurrency limits, timeouts, a bounded
// exponential backoff and a 429 circuit breaker. Public infrastructure is
// shared by everyone: nothing here retries in a tight loop.

import { LIMITS } from './config.ts';

export class HttpError extends Error {
  readonly status: number;
  readonly url: string;
  readonly body: string;
  constructor(status: number, url: string, body: string) {
    super(`HTTP ${status} on ${shortUrl(url)}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

/**
 * A public endpoint answered 429. Further calls to the same host and path
 * family fail fast until the window resets, instead of piling on.
 */
export class RateLimitError extends Error {
  readonly until: number;
  constructor(scope: string, until: number) {
    super(`rate limited by ${scope}, retry in ${Math.max(1, Math.ceil((until - Date.now()) / 1000))} s`);
    this.name = 'RateLimitError';
    this.until = until;
  }
}

const blockedUntil = new Map<string, number>();

/** Rate-limit scope: host plus first path segment (Horizon limits /paths separately). */
function scopeOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}/${u.pathname.split('/')[1] ?? ''}`;
  } catch {
    return url;
  }
}

export function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return url;
  }
}

interface CacheEntry {
  expires: number;
  value: unknown;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<unknown>>();
const MAX_CACHE_ENTRIES = 600;

function cacheGet(key: string): unknown | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (hit.expires < Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return hit.value;
}

function cacheSet(key: string, value: unknown, ttlMs: number): void {
  if (ttlMs <= 0) return;
  if (cache.size >= MAX_CACHE_ENTRIES) {
    // Drop the oldest insertion (Map keeps insertion order).
    const first = cache.keys().next().value;
    if (first !== undefined) cache.delete(first);
  }
  cache.set(key, { expires: Date.now() + ttlMs, value });
}

/** Clears cached responses whose key contains `fragment` (all when omitted). */
export function invalidate(fragment?: string): void {
  if (!fragment) {
    cache.clear();
    return;
  }
  for (const key of cache.keys()) if (key.includes(fragment)) cache.delete(key);
}

/** A counting semaphore: at most `max` tasks run at once. */
export function limiter(max: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    if (active >= max) return;
    const run = queue.shift();
    if (run) {
      active++;
      run();
    }
  };
  return function run<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      queue.push(() => {
        task()
          .then(resolve, reject)
          .finally(() => {
            active--;
            next();
          });
      });
      next();
    });
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function isRetryable(err: unknown): boolean {
  if (err instanceof RateLimitError) return false;
  if (err instanceof HttpError) return err.status >= 500;
  // Network failures and timeouts surface as TypeError / AbortError.
  return err instanceof Error && (err.name === 'TypeError' || err.name === 'AbortError' || err.name === 'TimeoutError');
}


export interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: string;
  headers?: Record<string, string>;
  /** Cache lifetime of a successful response. 0 disables caching. */
  ttlMs?: number;
  timeoutMs?: number;
  retries?: number;
  /** Per-host concurrency limiter. */
  limit?: <T>(task: () => Promise<T>) => Promise<T>;
  /** Treat these statuses as a valid `null` result instead of an error (e.g. 404). */
  nullOn?: readonly number[];
}

/**
 * Fetches JSON with cache, de-duplication, timeout and bounded backoff.
 * Throws HttpError on a non-2xx response, after bounded retries on 5xx and
 * network errors. A 429 is never retried: it throws RateLimitError and pauses
 * that endpoint family until its window resets.
 */
export async function requestJson<T>(url: string, opts: RequestOptions = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const key = `${method} ${url} ${opts.body ?? ''}`;
  const ttl = opts.ttlMs ?? 0;
  const cached = cacheGet(key);
  if (cached !== undefined) return cached as T;
  const pending = inflight.get(key);
  if (pending) return pending as Promise<T>;

  const scope = scopeOf(url);
  const attempt = async (): Promise<T> => {
    const blocked = blockedUntil.get(scope);
    if (blocked && blocked > Date.now()) throw new RateLimitError(scope, blocked);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? LIMITS.requestTimeoutMs);
    try {
      const res = await fetch(url, {
        method,
        body: opts.body,
        headers: { accept: 'application/json', ...(opts.body ? { 'content-type': 'application/json' } : {}), ...opts.headers },
        signal: ctrl.signal,
      });
      if (opts.nullOn?.includes(res.status)) return null as T;
      if (res.status === 429) {
        // X-RateLimit-Reset (seconds) is readable from node; browsers only see
        // CORS-exposed headers, so fall back to a 60 s pause.
        const reset = Number(res.headers.get('x-ratelimit-reset') ?? res.headers.get('retry-after'));
        const until = Date.now() + (Number.isFinite(reset) && reset > 0 ? reset * 1000 : 60_000);
        blockedUntil.set(scope, until);
        throw new RateLimitError(scope, until);
      }
      if (!res.ok) throw new HttpError(res.status, url, (await res.text()).slice(0, 500));
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  };

  const run = async (): Promise<T> => {
    const retries = opts.retries ?? LIMITS.retries;
    let lastErr: unknown;
    for (let i = 0; i <= retries; i++) {
      try {
        const value = await (opts.limit ? opts.limit(attempt) : attempt());
        cacheSet(key, value, ttl);
        return value;
      } catch (err) {
        lastErr = err;
        if (i === retries || !isRetryable(err)) break;
        await sleep(600 * 2 ** i + Math.floor(Math.random() * 250));
      }
    }
    throw lastErr;
  };

  const p = run().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** Human-readable reason for an error, for display next to the data it affects. */
export function describeError(err: unknown): string {
  if (err instanceof HttpError || err instanceof RateLimitError) return err.message;
  if (err instanceof Error) {
    if (err.name === 'AbortError' || err.name === 'TimeoutError') return 'request timed out';
    if (err.name === 'TypeError') return 'network error (blocked or unreachable)';
    return err.message;
  }
  return String(err);
}
