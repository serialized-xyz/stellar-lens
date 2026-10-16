// Exact decimal arithmetic for Stellar amounts. Horizon serves amounts as
// strings with 7 decimals; the ledger stores int64 stroops. Balances, reserves
// and comparisons are done on bigint stroops, never on floats.

import { STELLAR_DECIMALS } from './config.ts';

const SCALE = 10n ** BigInt(STELLAR_DECIMALS);

/** "123.4500000" -> 1234500000n. Throws on malformed input (fail loud). */
export function toStroops(amount: string): bigint {
  const m = /^(-)?(\d+)(?:\.(\d{1,7}))?$/.exec(amount.trim());
  if (!m) throw new Error(`malformed Stellar amount "${amount}"`);
  const [, neg, int, frac = ''] = m;
  const v = BigInt(int) * SCALE + BigInt(frac.padEnd(STELLAR_DECIMALS, '0'));
  return neg ? -v : v;
}

/** 1234500000n -> "123.45" (trailing zeros trimmed, as the Serialized API serves amounts). */
export function fromStroops(stroops: bigint, decimals = STELLAR_DECIMALS): string {
  const scale = 10n ** BigInt(decimals);
  const neg = stroops < 0n;
  const abs = neg ? -stroops : stroops;
  const int = abs / scale;
  const frac = (abs % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${int.toString()}${frac ? `.${frac}` : ''}`;
}

/** Normalises a Horizon amount string: "90.9300000" -> "90.93". */
export function trimAmount(amount: string): string {
  return fromStroops(toStroops(amount));
}

/** Float view of an amount for USD math and display only (never for balances). */
export function toNumber(amount: string | bigint, decimals = STELLAR_DECIMALS): number {
  if (typeof amount === 'bigint') return Number(amount) / 10 ** decimals;
  return Number(amount);
}

/** Integer amount scaled by `decimals` (SEP-41 i128 balances) -> decimal string. */
export function formatScaled(value: bigint, decimals: number): string {
  return fromStroops(value, decimals);
}
