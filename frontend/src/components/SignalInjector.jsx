import React, { useState } from 'react';
import { ingestSignal } from '../api/client';

const COMPONENTS = ['RDBMS_PRIMARY','RDBMS_REPLICA','CACHE_CLUSTER_01','KAFKA_BROKER_01','API_GATEWAY','MCP_HOST_01','REDIS_CACHE','SQS_QUEUE_01'];
const SIGNAL_TYPES = ['ERROR','LATENCY_SPIKE','TIMEOUT','CONNECTION_REFUSED','OOM','DISK_FULL'];

export function SignalInjector({ onSent }) {
  const [data, setData] = useState({ component: COMPONENTS[0], type: SIGNAL_TYPES[0], message: '', count: 1 });
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState(null);

  const handleInject = async () => {
    setLoading(true); setStatus(null);
    try {
      const msg = data.message || `${data.type} detected on ${data.component}`;
      for (let i = 0; i < data.count; i++) {
        await ingestSignal({ component_id: data.component, signal_type: data.type, message: msg, severity: 'HIGH' });
      }
      setStatus({ type: 'success', text: `✓ Injected ${data.count} signal${data.count > 1 ? 's' : ''} successfully.` });
      onSent?.();
    } catch (e) {
      setStatus({ type: 'error', text: '✗ ' + (e.response?.data?.detail || 'Injection failed.') });
    } finally { setLoading(false); }
  };

  return (
    <div className="glass" style={{ width: '100%', maxWidth: 520, padding: 28, borderRadius: 20 }}>
      <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 4 }}>Signal Injector</h2>
      <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 24 }}>Simulate infrastructure events</p>

      <div style={{ padding: '12px 16px', background: 'var(--p2-bg)', borderLeft: '3px solid var(--warning)', borderRadius: '0 4px 4px 0', marginBottom: 24 }}>
        <p style={{ fontSize: 12, color: 'var(--warning)' }}>Admin/SRE only. Sends real signals to the ingestion pipeline.</p>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div>
            <label style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>Component</label>
            <select value={data.component} onChange={e => setData({ ...data, component: e.target.value })}>
              {COMPONENTS.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>Signal Type</label>
            <select value={data.type} onChange={e => setData({ ...data, type: e.target.value })}>
              {SIGNAL_TYPES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        </div>

        <div>
          <label style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>Message (optional)</label>
          <input placeholder={`${data.type} on ${data.component}`} value={data.message} onChange={e => setData({ ...data, message: e.target.value })} />
        </div>

        <div>
          <label style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>Batch Count</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button onClick={() => setData({ ...data, count: Math.max(1, data.count - 1) })} style={{ width: 32, height: 32, borderRadius: '50%', background: 'var(--bg-raised)', color: 'var(--text-primary)', border: '1px solid var(--border-default)', fontSize: 18 }}>−</button>
            <span style={{ fontSize: 16, fontWeight: 700, minWidth: 30, textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}>{data.count}</span>
            <button onClick={() => setData({ ...data, count: Math.min(100, data.count + 1) })} style={{ width: 32, height: 32, borderRadius: '50%', background: 'var(--bg-raised)', color: 'var(--text-primary)', border: '1px solid var(--border-default)', fontSize: 18 }}>+</button>
          </div>
        </div>

        <button onClick={handleInject} disabled={loading} className="btn btn-primary" style={{ height: 44, marginTop: 12, fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 600, fontSize: 14 }}>
          {loading ? <span className="spinner" /> : `Inject ${data.count > 1 ? data.count + ' Signals' : 'Signal'}`}
        </button>

        {status && (
          <div style={{ padding: 12, borderRadius: 10, fontSize: 13, textAlign: 'center', border: `1px solid ${status.type === 'success' ? 'rgba(52,211,153,0.25)' : 'rgba(248,113,113,0.25)'}`, background: status.type === 'success' ? 'var(--p3-bg)' : 'var(--p0-bg)', color: status.type === 'success' ? 'var(--success)' : 'var(--error)', animation: 'slideDown 0.2s' }}>
            {status.text}
          </div>
        )}
      </div>
    </div>
  );
}
