import { useState, useRef, useCallback, useEffect } from 'react';
import { ToastContext } from '../context/toast';
import { Icon } from './Icon';

const MAX_TOASTS = 3;
const DEFAULT_TTL_MS = 4000;
// An alert (a new P0) stays until someone dismisses or opens it; a toast may also ask for its own `ttl`.
const ttlFor = ({ kind, ttl }) => ttl ?? (kind === 'alert' ? null : DEFAULT_TTL_MS);

function Toast({ toast, onDismiss }) {
  const { id, message, kind, action } = toast;
  const ttl = ttlFor(toast);
  useEffect(() => {
    if (ttl == null) return undefined;
    const t = setTimeout(() => onDismiss(id), ttl);
    return () => clearTimeout(t);
  }, [id, ttl, onDismiss]);

  return (
    <div className="toast" data-kind={kind} role={kind === 'alert' ? 'alert' : undefined}>
      <span className="toast-msg">{message}</span>
      {action && (
        <button type="button" className="toast-action"
          onClick={() => { action.onClick(); onDismiss(id); }}>
          {action.label}
        </button>
      )}
      <button type="button" className="toast-close" aria-label="Dismiss" onClick={() => onDismiss(id)}><Icon name="x" size={14} /></button>
    </div>
  );
}

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const nextId = useRef(0);
  const dismiss = useCallback((id) => setToasts(list => list.filter(t => t.id !== id)), []);
  const toast = useCallback((message, { kind = 'success', action, ttl } = {}) => {
    const id = ++nextId.current;
    setToasts(list => [...list, { id, message, kind, action, ttl }].slice(-MAX_TOASTS));
  }, []);

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div className="toaster" aria-live="polite">
        {toasts.map(t => <Toast key={t.id} toast={t} onDismiss={dismiss} />)}
      </div>
    </ToastContext.Provider>
  );
}
