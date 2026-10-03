import { useState, useRef, useCallback, useEffect } from 'react';
import { ToastContext } from '../context/toast';
import { Icon } from './Icon';

const MAX_TOASTS = 3;
const TTL_MS = { alert: 10000 };  // a new P0 stays longer than a "Saved"
const DEFAULT_TTL_MS = 4000;

function Toast({ toast, onDismiss }) {
  const { id, message, kind, action } = toast;
  useEffect(() => {
    const t = setTimeout(() => onDismiss(id), TTL_MS[kind] ?? DEFAULT_TTL_MS);
    return () => clearTimeout(t);
  }, [id, kind, onDismiss]);

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
  const toast = useCallback((message, { kind = 'success', action } = {}) => {
    const id = ++nextId.current;
    setToasts(list => [...list, { id, message, kind, action }].slice(-MAX_TOASTS));
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
