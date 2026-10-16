// SEP-1: issuer home domains and their stellar.toml. An asset is "verified"
// only when the stellar.toml of its issuer's home domain lists that currency
// (same code, same issuer). Anything else is shown with the reason.

import { StellarToml } from '@stellar/stellar-sdk';
import { LIMITS } from './config.ts';
import { getAccount } from './horizon.ts';
import { describeError, limiter } from './http.ts';

const tomlLimit = limiter(LIMITS.tomlConcurrency);

export interface TomlCurrency {
  code: string;
  issuer: string;
  name?: string;
  isAssetAnchored?: boolean;
  anchorAsset?: string;
}

export type TomlResult =
  | { ok: true; domain: string; orgName: string | null; currencies: TomlCurrency[] }
  | { ok: false; domain: string; error: string };

const tomlCache = new Map<string, Promise<TomlResult>>();

/** Fetches and parses https://{domain}/.well-known/stellar.toml (cached for the session). */
export function getStellarToml(domain: string): Promise<TomlResult> {
  const key = domain.toLowerCase();
  const hit = tomlCache.get(key);
  if (hit) return hit;
  const p = tomlLimit(async (): Promise<TomlResult> => {
    try {
      const toml = await StellarToml.Resolver.resolve(key, { timeout: 8_000 });
      const currencies: TomlCurrency[] = [];
      for (const c of toml.CURRENCIES ?? []) {
        if (typeof c.code === 'string' && typeof c.issuer === 'string') {
          currencies.push({
            code: c.code,
            issuer: c.issuer,
            name: typeof c.name === 'string' ? c.name : undefined,
            isAssetAnchored: typeof c.is_asset_anchored === 'boolean' ? c.is_asset_anchored : undefined,
            anchorAsset: typeof c.anchor_asset === 'string' ? c.anchor_asset : undefined,
          });
        }
      }
      const org = toml.DOCUMENTATION?.ORG_NAME;
      return { ok: true, domain: key, orgName: typeof org === 'string' ? org : null, currencies };
    } catch (err) {
      return { ok: false, domain: key, error: tomlError(err) };
    }
  });
  tomlCache.set(key, p);
  return p;
}

function tomlError(err: unknown): string {
  const e = err as { response?: { status?: number }; message?: string; code?: string };
  if (e?.response?.status) return `stellar.toml returned HTTP ${e.response.status}`;
  const msg = describeError(err);
  if (/network|fetch|cors/i.test(msg)) return 'stellar.toml unreachable (network or CORS)';
  if (/timeout/i.test(msg)) return 'stellar.toml timed out';
  return `stellar.toml unreadable: ${msg.slice(0, 120)}`;
}

export interface IssuerInfo {
  issuer: string;
  homeDomain: string | null;
  /** Issuer account flags. */
  authRequired: boolean;
  authRevocable: boolean;
  authImmutable: boolean;
  clawbackEnabled: boolean;
  exists: boolean;
}

const issuerCache = new Map<string, Promise<IssuerInfo>>();

export function getIssuer(issuer: string): Promise<IssuerInfo> {
  const hit = issuerCache.get(issuer);
  if (hit) return hit;
  const p = getAccount(issuer, 10 * 60_000).then((acc): IssuerInfo => {
    if (!acc)
      return {
        issuer,
        homeDomain: null,
        authRequired: false,
        authRevocable: false,
        authImmutable: false,
        clawbackEnabled: false,
        exists: false,
      };
    return {
      issuer,
      homeDomain: acc.home_domain?.trim() || null,
      authRequired: acc.flags.auth_required,
      authRevocable: acc.flags.auth_revocable,
      authImmutable: acc.flags.auth_immutable,
      clawbackEnabled: acc.flags.auth_clawback_enabled,
      exists: true,
    };
  });
  // Do not keep a failed lookup: a later render retries it.
  p.catch(() => issuerCache.delete(issuer));
  issuerCache.set(issuer, p);
  return p;
}

export type Verification =
  | {
      status: 'verified';
      domain: string;
      orgName: string | null;
      currencyName: string | null;
      /** Where the issuer-asset pair was confirmed: the issuer's stellar.toml, or the issuer's own published docs. */
      source: 'stellar.toml' | 'issuer docs';
      sourceUrl: string;
    }
  | { status: 'not_listed'; domain: string; detail: string }
  | { status: 'no_home_domain'; detail: string }
  | { status: 'toml_error'; domain: string; detail: string }
  | { status: 'issuer_missing'; detail: string }
  | { status: 'not_checked'; detail: string }
  | { status: 'error'; detail: string };

/**
 * Any issuer can set any home_domain, and every visitor's browser would fetch
 * https://<home_domain>/.well-known/stellar.toml. Only public DNS hostnames
 * are fetched: no IP literal, no port, no single-label name such as
 * localhost, and never a Serialized host.
 */
const PUBLIC_HOSTNAME = /^(?=.{4,253}$)(?!-)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const REFUSED_DOMAINS = ['serialized.xyz', 'serialized.cloud', 'serializedaudit.io', 'serialized.trade'];

export function isFetchableHomeDomain(domain: string): boolean {
  const d = domain.toLowerCase();
  if (!PUBLIC_HOSTNAME.test(d)) return false;
  return !REFUSED_DOMAINS.some((r) => d === r || d.endsWith(`.${r}`));
}

/**
 * Issuer-asset pairs confirmed by the issuer's own published documentation,
 * used when the issuer's stellar.toml cannot confirm them. Circle sets
 * home_domain circle.com on its Stellar issuers, but
 * https://circle.com/.well-known/stellar.toml redirects to a 404 (checked
 * 2026-10-16), so SEP-1 alone would show USDC and EURC as unverified.
 */
const ISSUER_DOCS: { code: string; issuer: string; domain: string; orgName: string; currencyName: string; url: string }[] = [
  {
    code: 'USDC',
    issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
    domain: 'circle.com',
    orgName: 'Circle',
    currencyName: 'USD Coin',
    url: 'https://developers.circle.com/stablecoins/usdc-contract-addresses',
  },
  {
    code: 'EURC',
    issuer: 'GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2',
    domain: 'circle.com',
    orgName: 'Circle',
    currencyName: 'EURC',
    url: 'https://developers.circle.com/stablecoins/eurc-contract-addresses',
  },
];

/** SEP-1 verification of one classic asset, then the issuer-docs registry. Never throws. */
export async function verifyAsset(code: string, issuer: string): Promise<Verification> {
  const sep1 = await verifyAssetSep1(code, issuer);
  if (sep1.status === 'verified' || sep1.status === 'issuer_missing') return sep1;
  const doc = ISSUER_DOCS.find((d) => d.code === code && d.issuer === issuer);
  if (!doc) return sep1;
  return {
    status: 'verified',
    domain: doc.domain,
    orgName: doc.orgName,
    currencyName: doc.currencyName,
    source: 'issuer docs',
    sourceUrl: doc.url,
  };
}

async function verifyAssetSep1(code: string, issuer: string): Promise<Verification> {
  try {
    const info = await getIssuer(issuer);
    if (!info.exists) return { status: 'issuer_missing', detail: 'issuer account no longer exists (merged)' };
    if (!info.homeDomain) return { status: 'no_home_domain', detail: 'issuer sets no home domain' };
    if (!isFetchableHomeDomain(info.homeDomain))
      return { status: 'toml_error', domain: info.homeDomain, detail: 'home domain is not a public hostname: stellar.toml not fetched' };
    const toml = await getStellarToml(info.homeDomain);
    if (!toml.ok) return { status: 'toml_error', domain: info.homeDomain, detail: toml.error };
    const cur = toml.currencies.find((c) => c.code === code && c.issuer === issuer);
    if (!cur)
      return {
        status: 'not_listed',
        domain: info.homeDomain,
        detail: `${info.homeDomain} stellar.toml does not list ${code} from this issuer`,
      };
    return {
      status: 'verified',
      domain: info.homeDomain,
      orgName: toml.orgName,
      currencyName: cur.name ?? null,
      source: 'stellar.toml',
      sourceUrl: `https://${info.homeDomain}/.well-known/stellar.toml`,
    };
  } catch (err) {
    return { status: 'error', detail: describeError(err) };
  }
}
