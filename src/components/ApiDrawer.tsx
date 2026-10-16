import { useEffect, useMemo } from 'react';
import { CopyButton, Icon } from './ui.tsx';

export type Endpoint = 'positions' | 'transfers' | 'swaps';

export interface EndpointView {
  id: Endpoint;
  label: string;
  path: string;
  json: unknown | null;
  note: string;
  ready: boolean;
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

export function ApiDrawer(props: { open: boolean; views: EndpointView[]; active: Endpoint; onSelect: (e: Endpoint) => void; onClose: () => void }) {
  const view = props.views.find((v) => v.id === props.active) ?? props.views[0];
  const text = useMemo(() => (view.json ? JSON.stringify(view.json, null, 2) : ''), [view.json]);
  const html = useMemo(() => (text ? highlightJson(text) : ''), [text]);

  useEffect(() => {
    if (!props.open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props.open, props.onClose]);

  if (!props.open) return null;
  const lines = text ? text.split('\n').length : 0;
  return (
    <div className="drawer-wrap" role="dialog" aria-modal="true" aria-label="API response preview">
      <div className="drawer-backdrop" onClick={props.onClose} />
      <aside className="drawer">
        <div className="drawer-head">
          <div className="drawer-title">
            <Icon name="braces" size={16} />
            <span>Serialized Data API</span>
            <span className="preview-badge">Shape preview</span>
          </div>
          <button type="button" className="icon-btn" onClick={props.onClose} aria-label="Close">
            <Icon name="close" size={16} />
          </button>
        </div>
        <div className="drawer-tabs" role="tablist">
          {props.views.map((v) => (
            <button key={v.id} type="button" role="tab" className={v.id === view.id ? 'on' : ''} onClick={() => props.onSelect(v.id)}>
              {v.label}
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
                <span className="mono muted">
                  application/json · {lines} lines · {(new Blob([text]).size / 1024).toFixed(1)} KB
                </span>
                <CopyButton text={text} label="Copy JSON" className="copy-json" />
              </div>
              <pre className="code" dangerouslySetInnerHTML={{ __html: html }} />
            </>
          ) : (
            <div className="code-wait">Waiting for the data to finish loading...</div>
          )}
        </div>
      </aside>
    </div>
  );
}
