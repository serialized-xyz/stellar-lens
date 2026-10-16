// JSON-RPC client for public Stellar RPC endpoints, with ordered fallback.
// Raw JSON-RPC (no SDK server class) so that every call goes through the same
// cache, timeout and backoff rules as Horizon.

import { LIMITS, RPC_URLS } from './config.ts';
import { describeError, limiter, requestJson } from './http.ts';

const rpcLimit = limiter(LIMITS.rpcConcurrency);

interface JsonRpcResponse<T> {
  jsonrpc: '2.0';
  id: number;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

export class RpcError extends Error {
  readonly code: number;
  readonly endpoint: string;
  constructor(code: number, message: string, endpoint: string) {
    super(`RPC error ${code}: ${message}`);
    this.name = 'RpcError';
    this.code = code;
    this.endpoint = endpoint;
  }
}

/** Index of the endpoint that answered last; tried first next time. */
let preferred = 0;

export interface RpcResult<T> {
  result: T;
  endpoint: string;
}

/**
 * Calls `method` on the preferred endpoint, then on the others in order when
 * it fails at the transport level. A JSON-RPC error from a healthy endpoint is
 * returned as is (it would be the same everywhere).
 */
export async function rpcCall<T>(method: string, params: unknown, ttlMs = 0): Promise<RpcResult<T>> {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  const order = RPC_URLS.map((_, i) => (preferred + i) % RPC_URLS.length);
  const failures: string[] = [];
  for (const i of order) {
    const endpoint = RPC_URLS[i];
    try {
      const res = await requestJson<JsonRpcResponse<T>>(endpoint, { method: 'POST', body, ttlMs, limit: rpcLimit, retries: 1 });
      if (res.error) throw new RpcError(res.error.code, res.error.message, endpoint);
      if (res.result === undefined) throw new Error('empty JSON-RPC result');
      preferred = i;
      return { result: res.result, endpoint };
    } catch (err) {
      if (err instanceof RpcError) throw err;
      failures.push(`${new URL(endpoint).host}: ${describeError(err)}`);
    }
  }
  throw new Error(`all Stellar RPC endpoints failed (${failures.join('; ')})`);
}

export interface RpcHealth {
  status: string;
  latestLedger: number;
  latestLedgerCloseTime?: string;
  oldestLedger: number;
}

/**
 * Latest ledger for the ticker. getHealth carries the sequence and close time
 * in ~200 bytes; getLatestLedger also returns the full ledger metadata
 * (about 2.7 MB per call on protocol 29), far too heavy to poll.
 */
export function getHealth() {
  return rpcCall<RpcHealth>('getHealth', {}, 4_000);
}

export interface RpcLedgerEntry {
  key: string;
  xdr: string;
  lastModifiedLedgerSeq: number;
  liveUntilLedgerSeq?: number;
}

export interface RpcLedgerEntries {
  entries: RpcLedgerEntry[] | null;
  latestLedger: number;
}

export function getLedgerEntries(keys: readonly string[]) {
  return rpcCall<RpcLedgerEntries>('getLedgerEntries', { keys }, 0);
}

export interface RpcSimulation {
  latestLedger: number;
  error?: string;
  results?: Array<{ xdr: string; auth: string[] }>;
}

export function simulateTransaction(transactionXdr: string, ttlMs = 30_000) {
  return rpcCall<RpcSimulation>('simulateTransaction', { transaction: transactionXdr }, ttlMs);
}
