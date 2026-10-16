import { useState } from 'react';
import type { ReactNode } from 'react';
import { explorer } from '../data/config.ts';
import { shortAddress } from '../data/stellar.ts';

// ---------------------------------------------------------------- icons

const paths = {
  copy: 'M9 9h10v10H9zM5 15V5h10',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  ext: 'M14 5h5v5M19 5l-8 8M18 14v5H5V6h5',
  in: 'M17 7L7 17M7 9v8h8',
  out: 'M7 17L17 7M9 7h8v8',
  swap: 'M7 7h11l-3-3M17 17H6l3 3',
  plus: 'M12 5v14M5 12h14',
  merge: 'M7 5v6a4 4 0 004 4h6M14 12l3 3-3 3',
  code: 'M9 8l-4 4 4 4M15 8l4 4-4 4',
  drop: 'M12 4c3 4 5 6.5 5 9a5 5 0 01-10 0c0-2.5 2-5 5-9z',
  dot: 'M12 11.9v.2',
  search: 'M11 18a7 7 0 100-14 7 7 0 000 14zM20 20l-4-4',
  refresh: 'M19 8a8 8 0 10.8 6M19 4v4h-4',
  braces: 'M8 4H7a2 2 0 00-2 2v4l-2 2 2 2v4a2 2 0 002 2h1M16 4h1a2 2 0 012 2v4l2 2-2 2v4a2 2 0 01-2 2h-1',
  close: 'M6 6l12 12M18 6L6 18',
  wallet: 'M4 7h14a2 2 0 012 2v8a2 2 0 01-2 2H4zM4 7l11-3v3M16 13h.01',
  shield: 'M12 3l7 3v5c0 5-3.5 8.5-7 10-3.5-1.5-7-5-7-10V6z',
  chevron: 'M9 6l6 6-6 6',
  alert: 'M12 4l9 16H3zM12 10v4M12 17h.01',
  clock: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 7v5l3 2',
  op: 'M6 8h12M6 12h12M6 16h7',
} as const;

export type IconName = keyof typeof paths;

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}

export function StellarMark({ size = 18, className }: { size?: number; className?: string }) {
  return (
    <svg className={className} width={size * 1.18} height={size} viewBox="0 0 236.36 200" fill="currentColor" aria-label="Stellar" role="img">
      <path d="M203,26.16l-28.46,14.5-137.43,70a82.49,82.49,0,0,1-.7-10.69A81.87,81.87,0,0,1,158.2,28.6l16.29-8.3,2.43-1.24A100,100,0,0,0,18.18,100q0,3.82.29,7.61a18.19,18.19,0,0,1-9.88,17.58L0,129.57V150l25.29-12.89,0,0,8.19-4.18,8.07-4.11v0L186.43,55l16.28-8.29,33.65-17.15V9.14Z" />
      <path d="M236.36,50,49.78,145,33.5,153.31,0,170.38v20.41l33.27-16.95,28.46-14.5L199.3,89.24A83.45,83.45,0,0,1,200,100,81.87,81.87,0,0,1,78.09,171.36l-1,.53-17.66,9A100,100,0,0,0,218.18,100c0-2.57-.1-5.14-.29-7.68a18.2,18.2,0,0,1,9.87-17.58l8.6-4.38Z" />
    </svg>
  );
}

// ---------------------------------------------------------------- small parts

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

export function CopyButton({ text, label, className }: { text: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={`icon-btn ${className ?? ''}`}
      title={done ? 'Copied' : 'Copy'}
      aria-label={label ?? 'Copy'}
      onClick={async (e) => {
        e.stopPropagation();
        if (await copyText(text)) {
          setDone(true);
          setTimeout(() => setDone(false), 1400);
        }
      }}
    >
      <Icon name={done ? 'check' : 'copy'} size={14} />
      {label ? <span>{done ? 'Copied' : label}</span> : null}
    </button>
  );
}

export function ExtLink({ href, children, className, title }: { href: string; children: ReactNode; className?: string; title?: string }) {
  return (
    <a className={`ext ${className ?? ''}`} href={href} target="_blank" rel="noopener noreferrer" title={title} onClick={(e) => e.stopPropagation()}>
      {children}
    </a>
  );
}

export function AccountLink({ id, head = 4, tail = 4, self }: { id: string; head?: number; tail?: number; self?: string }) {
  if (self && id === self) return <span className="addr self">this account</span>;
  return (
    <ExtLink href={id.startsWith('C') ? explorer.contract(id) : explorer.account(id)} className="mono addr" title={id}>
      {shortAddress(id, head, tail)}
    </ExtLink>
  );
}

const MARK_TINTS = ['#2B4A86', '#2A5C74', '#3B3F86', '#24606A', '#4A3E7A', '#2F5578', '#365A4E', '#5A4A2E'];

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function AssetMark({ code, seed, kind }: { code: string; seed: string; kind?: 'native' | 'pool' | 'sep41' | 'credit' }) {
  if (kind === 'native')
    return (
      <span className="mark mark-native" aria-hidden="true">
        <StellarMark size={13} />
      </span>
    );
  const letters = kind === 'pool' ? 'LP' : (code.replace(/[^A-Za-z0-9]/g, '').charAt(0) || '?').toUpperCase();
  return (
    <span className={`mark ${kind === 'sep41' ? 'mark-sep41' : kind === 'pool' ? 'mark-pool' : ''}`} style={{ background: MARK_TINTS[hash(seed) % MARK_TINTS.length] }} aria-hidden="true">
      {letters}
    </span>
  );
}

export function Spinner({ size = 14 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} aria-label="Loading" />;
}

export function Skeleton({ w = '100%', h = 12 }: { w?: string | number; h?: number }) {
  return <span className="skeleton" style={{ width: w, height: h }} />;
}

export function Badge({ tone = 'muted', children, title }: { tone?: 'muted' | 'accent' | 'ok' | 'warn' | 'bad'; children: ReactNode; title?: string }) {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      {children}
    </span>
  );
}
