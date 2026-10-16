import { useEffect, useMemo, useRef } from 'react';
import { CopyButton, Icon } from './ui.tsx';

export type Endpoint = 'positions' | 'transfers' | 'swaps';

export interface EndpointView {
  id: Endpoint;
  label: string;
  /** Tab label on narrow screens. */
  short: string;
  path: string;
  json: unknown | null;
  note: string;
  ready: boolean;
  /** Why there is no JSON to show (account not found, Horizon error...). */
  error: string | null;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** JSON with syntax classes. Input is escaped before any markup is added. */
export function highlightJson(text: string): string {
  return escapeHtml(text).replace(
    /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    (m) => {
      let cls = 'n';
      if (m.startsWith('"')) cls = m.endsWith(':') ? 'k' : 's';
      else if (m === 'true' || m === 'false') cls = 'b';
      else if (m === 'null') cls = 'z';
      return `<span class="j-${cls}">${m}</span>`;
    },
  );
}

const FOCUSABLE = 'button:not([disabled]), [href], input, [tabindex]:not([tabindex="-1"])';

export function ApiDrawer(props: { open: boolean; views: EndpointView[]; active: Endpoint; onSelect: (e: Endpoint) => void; onClose: () => void }) {
  const view = props.views.find((v) => v.id === props.active) ?? props.views[0];
  const text = useMemo(() => (view.json ? JSON.stringify(view.json, null, 2) : ''), [view.json]);
  const html = useMemo(() => (text ? highlightJson(text) : ''), [text]);
  const panel = useRef<HTMLElement | null>(null);
  // The latest onClose, without re-running the focus effect on every render.
  const onClose = useRef(props.onClose);
  onClose.current = props.onClose;

  // Escape closes; Tab stays inside the dialog; focus moves in on open and back on close.
  useEffect(() => {
    if (!props.open) return;
    const before = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLElement>('.drawer-close')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose.current();
        return;
      }
      if (e.key !== 'Tab' || !panel.current) return;
      const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      } else if (!panel.current.contains(document.activeElement)) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      before?.focus?.();
    };
  }, [props.open]);

  if (!props.open) return null;
  const lines = text ? text.split('\n').length : 0;
  return (
    <div className="drawer-wrap" role="dialog" aria-modal="true" aria-label="API response preview">
      <div className="drawer-backdrop" onClick={props.onClose} />
      <aside className="drawer" ref={panel}>
        <div className="drawer-head">
          <div className="drawer-title">
            <Icon name="braces" size={16} />
            <span>Serialized Data API</span>
            <span className="preview-badge">Shape preview</span>
          </div>
          <button type="button" className="icon-btn drawer-close" onClick={props.onClose} aria-label="Close">
            <Icon name="close" size={16} />
          </button>
        </div>
        <div className="drawer-tabs" role="tablist" aria-label="Endpoint">
          {props.views.map((v) => (
            <button key={v.id} type="button" role="tab" aria-selected={v.id === view.id} className={v.id === view.id ? 'on' : ''} onClick={() => props.onSelect(v.id)}>
              <span className="tab-long">{v.label}</span>
              <span className="tab-short">{v.short}</span>
            </button>
          ))}
        </div>
        <div className="drawer-req">
          <span className="method">GET</span>
          <code className="req-path">{view.path}</code>
          <CopyButton text={view.path} />
        </div>
        <p className="drawer-note">
          <strong>Preview:</strong> computed in your browser from Horizon and Stellar RPC, in the shape of our API. <span className="mono">chain=stellar</span> is on
          our roadmap and not served by the Serialized API yet. {view.note}
        </p>
        <div className="drawer-body">
          {view.ready && text ? (
            <>
              <div className="code-bar">
                <span className="mono muted code-size">
                  <span className="code-mime">application/json · </span>
                  {lines} lines · {(new Blob([text]).size / 1024).toFixed(1)} KB
                </span>
                <CopyButton text={text} label="Copy JSON" className="copy-json" />
              </div>
              <pre className="code" dangerouslySetInnerHTML={{ __html: html }} />
            </>
          ) : view.error ? (
            <div className="code-wait code-error">
              <Icon name="alert" size={14} /> No response to show: {view.error}
            </div>
          ) : (
            <div className="code-wait">Waiting for the data to finish loading...</div>
          )}
        </div>
      </aside>
    </div>
  );
}
