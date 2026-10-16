// Stellar protocol helpers: address parsing (G and muxed M), asset ids,
// ledger keys for getLedgerEntries, decoding of ledger entries, and SEP-41
// token reads through simulateTransaction.

import {
  Account,
  Address,
  Asset,
  Contract,
  Keypair,
  LiquidityPoolId,
  MuxedAccount,
  StrKey,
  TransactionBuilder,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';
import { NETWORK_PASSPHRASE } from './config.ts';
import { getLedgerEntries, simulateTransaction } from './rpc.ts';

// ---------------------------------------------------------------- addresses

export interface ParsedAddress {
  /** The base G account, the one every read is done on. */
  account: string;
  /** The input as typed (G or M). */
  input: string;
  /** Muxed id when the input is an M address (CAP-27). */
  muxedId: string | null;
}

export type AddressParse = { ok: true; value: ParsedAddress } | { ok: false; error: string };

export function parseAddress(raw: string): AddressParse {
  const input = raw.trim().toUpperCase();
  if (!input) return { ok: false, error: 'Enter a Stellar address (G... or M...).' };
  if (StrKey.isValidEd25519PublicKey(input)) return { ok: true, value: { account: input, input, muxedId: null } };
  if (StrKey.isValidMed25519PublicKey(input)) {
    const muxed = MuxedAccount.fromAddress(input, '0');
    return { ok: true, value: { account: muxed.baseAccount().accountId(), input, muxedId: muxed.id() } };
  }
  if (input.startsWith('C') && StrKey.isValidContract(input)) {
    return { ok: false, error: 'This is a contract address (C...). The preview reads accounts: enter a G... or M... address.' };
  }
  if (input.startsWith('S')) return { ok: false, error: 'This looks like a SECRET key. Never paste it anywhere. Enter the public key (G...).' };
  return { ok: false, error: 'Not a valid Stellar account address. Expected G... (56 characters) or M... (69 characters).' };
}

export function shortAddress(a: string, head = 4, tail = 4): string {
  return a.length > head + tail + 1 ? `${a.slice(0, head)}...${a.slice(-tail)}` : a;
}

// ---------------------------------------------------------------- assets

/** SEP-11 asset id: "native" or "CODE:ISSUER". */
export type AssetId = string;

export function assetId(type: string | undefined, code?: string, issuer?: string): AssetId {
  if (!type || type === 'native') return 'native';
  if (!code || !issuer) throw new Error(`asset of type ${type} without code or issuer`);
  return `${code}:${issuer}`;
}

export function assetCode(id: AssetId): string {
  return id === 'native' ? 'XLM' : id.split(':')[0];
}

export function assetIssuer(id: AssetId): string | null {
  return id === 'native' ? null : (id.split(':')[1] ?? null);
}

function toSdkAsset(id: AssetId): Asset {
  if (id === 'native') return Asset.native();
  const [code, issuer] = id.split(':');
  return new Asset(code, issuer);
}

/** Contract id of the Stellar Asset Contract (SAC) of a classic asset. */
export function sacContractId(id: AssetId): string {
  return toSdkAsset(id).contractId(NETWORK_PASSPHRASE);
}

// ---------------------------------------------------------------- ledger keys

const accountXdrId = (g: string) => Keypair.fromPublicKey(g).xdrAccountId();

export function accountKey(account: string): string {
  return xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId: accountXdrId(account) })).toXDR('base64');
}

export function trustlineKey(account: string, asset: AssetId): string {
  return xdr.LedgerKey.trustline(
    new xdr.LedgerKeyTrustLine({ accountId: accountXdrId(account), asset: toSdkAsset(asset).toTrustLineXDRObject() }),
  ).toXDR('base64');
}

export function poolShareTrustlineKey(account: string, poolId: string): string {
  return xdr.LedgerKey.trustline(
    new xdr.LedgerKeyTrustLine({ accountId: accountXdrId(account), asset: new LiquidityPoolId(poolId).toXDRObject() }),
  ).toXDR('base64');
}

export function liquidityPoolKey(poolId: string): string {
  return xdr.LedgerKey.liquidityPool(new xdr.LedgerKeyLiquidityPool({ liquidityPoolId: new xdr.PoolId(poolId) })).toXDR(
    'base64',
  );
}

// ---------------------------------------------------------------- decoded entries

export interface AccountState {
  balance: bigint;
  numSubEntries: number;
  numSponsoring: number;
  numSponsored: number;
  buyingLiabilities: bigint;
  sellingLiabilities: bigint;
  flags: number;
}

export interface TrustlineState {
  balance: bigint;
  limit: bigint;
  flags: number;
  buyingLiabilities: bigint;
  sellingLiabilities: bigint;
}

export interface PoolState {
  reserveA: bigint;
  reserveB: bigint;
  totalPoolShares: bigint;
  poolSharesTrustLineCount: bigint;
  feeBp: number;
}

export function decodeAccount(entryXdr: string): AccountState {
  const d = xdr.LedgerEntryData.fromXDR(entryXdr, 'base64');
  if (d.type !== 'account') throw new Error(`expected an account entry, got ${d.type}`);
  const a = d.account;
  let buying = 0n;
  let selling = 0n;
  let numSponsoring = 0;
  let numSponsored = 0;
  if (a.ext.type === 'v1') {
    buying = a.ext.v1.liabilities.buying;
    selling = a.ext.v1.liabilities.selling;
    if (a.ext.v1.ext.type === 'v2') {
      numSponsoring = a.ext.v1.ext.v2.numSponsoring;
      numSponsored = a.ext.v1.ext.v2.numSponsored;
    }
  }
  return {
    balance: a.balance,
    numSubEntries: a.numSubEntries,
    numSponsoring,
    numSponsored,
    buyingLiabilities: buying,
    sellingLiabilities: selling,
    flags: a.flags,
  };
}

export function decodeTrustline(entryXdr: string): TrustlineState {
  const d = xdr.LedgerEntryData.fromXDR(entryXdr, 'base64');
  if (d.type !== 'trustline') throw new Error(`expected a trustline entry, got ${d.type}`);
  const t = d.trustLine;
  const liab = t.ext.type === 'v1' ? t.ext.v1.liabilities : null;
  return {
    balance: t.balance,
    limit: t.limit,
    flags: t.flags,
    buyingLiabilities: liab?.buying ?? 0n,
    sellingLiabilities: liab?.selling ?? 0n,
  };
}

export function decodeLiquidityPool(entryXdr: string): PoolState {
  const d = xdr.LedgerEntryData.fromXDR(entryXdr, 'base64');
  if (d.type !== 'liquidityPool') throw new Error(`expected a liquidity pool entry, got ${d.type}`);
  const cp = d.liquidityPool.body.constantProduct;
  return {
    reserveA: cp.reserveA,
    reserveB: cp.reserveB,
    totalPoolShares: cp.totalPoolShares,
    poolSharesTrustLineCount: cp.poolSharesTrustLineCount,
    feeBp: cp.params.fee,
  };
}

/** Trustline flags (CAP-18, CAP-35). */
export const TRUSTLINE_FLAGS = {
  AUTHORIZED: 1,
  AUTHORIZED_TO_MAINTAIN_LIABILITIES: 2,
  CLAWBACK_ENABLED: 4,
} as const;

export interface LedgerRead<T> {
  /** null when the entry does not exist on the ledger. */
  state: T | null;
  lastModifiedLedger: number | null;
  latestLedger: number;
  endpoint: string;
}

/** Reads several ledger entries in one getLedgerEntries call, keyed by base64 key. */
export async function readEntries(keys: readonly string[]): Promise<{
  byKey: Map<string, { xdr: string; lastModifiedLedgerSeq: number }>;
  latestLedger: number;
  endpoint: string;
}> {
  const { result, endpoint } = await getLedgerEntries(keys);
  const byKey = new Map<string, { xdr: string; lastModifiedLedgerSeq: number }>();
  for (const e of result.entries ?? []) byKey.set(e.key, { xdr: e.xdr, lastModifiedLedgerSeq: e.lastModifiedLedgerSeq });
  return { byKey, latestLedger: result.latestLedger, endpoint };
}

export async function readAccount(account: string): Promise<LedgerRead<AccountState>> {
  const key = accountKey(account);
  const { byKey, latestLedger, endpoint } = await readEntries([key]);
  const e = byKey.get(key);
  return { state: e ? decodeAccount(e.xdr) : null, lastModifiedLedger: e?.lastModifiedLedgerSeq ?? null, latestLedger, endpoint };
}

// ---------------------------------------------------------------- SEP-41

async function simulateCall(contractId: string, source: string, fn: string, args: xdr.ScVal[] = []) {
  const tx = new TransactionBuilder(new Account(source, '0'), { fee: '100', networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(new Contract(contractId).call(fn, ...args))
    .setTimeout(0)
    .build();
  const { result, endpoint } = await simulateTransaction(tx.toXDR());
  if (result.error) throw new Error(`${fn}() simulation failed: ${result.error.split('\n')[0]}`);
  const ret = result.results?.[0]?.xdr;
  if (!ret) throw new Error(`${fn}() simulation returned no value`);
  return { value: scValToNative(xdr.ScVal.fromXDR(ret, 'base64')) as unknown, latestLedger: result.latestLedger, endpoint };
}

export interface Sep41Balance {
  contractId: string;
  balance: bigint;
  decimals: number;
  symbol: string;
  name: string;
  latestLedger: number;
}

/** balance(), decimals(), symbol() and name() of a SEP-41 token, read by simulation (no transaction is ever submitted). */
export async function readSep41(contractId: string, holder: string): Promise<Sep41Balance> {
  const [bal, dec, sym, name] = await Promise.all([
    simulateCall(contractId, holder, 'balance', [new Address(holder).toScVal()]),
    simulateCall(contractId, holder, 'decimals'),
    simulateCall(contractId, holder, 'symbol'),
    simulateCall(contractId, holder, 'name'),
  ]);
  if (typeof bal.value !== 'bigint') throw new Error(`balance() returned ${typeof bal.value}, expected i128`);
  const decimals = Number(dec.value);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 38) throw new Error(`implausible decimals() ${String(dec.value)}`);
  return {
    contractId,
    balance: bal.value,
    decimals,
    symbol: String(sym.value),
    name: String(name.value),
    latestLedger: bal.latestLedger,
  };
}
