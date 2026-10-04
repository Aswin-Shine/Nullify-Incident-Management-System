import { useState } from 'react';
import { ingestSignal, errorMessage } from '../api/client';
import { Field } from './Field';
import { plural } from '../format';

// DEMO_APP matches no alert-strategy token, so it opens a calm P3 (not a P0 that pages anyone).
const COMPONENTS = ['DEMO_APP','RDBMS_PRIMARY','RDBMS_REPLICA','CACHE_CLUSTER_01','KAFKA_BROKER_01','API_GATEWAY','MCP_HOST_01','REDIS_CACHE','SQS_QUEUE_01'];
const SIGNAL_TYPES = ['ERROR','LATENCY_SPIKE','TIMEOUT','CONNECTION_REFUSED','OOM','DISK_FULL'];

export function SignalInjector({ onSent }) {
  const [data, setData] = useState({ component: COMPONENTS[0], type: SIGNAL_TYPES[0], message: '', count: 1 });
  const defaultMessage = `${data.type} detected on ${data.component}`;
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState(null);

  const handleInject = async (e) => {
    e.preventDefault();
    setLoading(true); setStatus(null);
    try {
      const msg = data.message || defaultMessage;
      for (let i = 0; i < data.count; i++) {
        await ingestSignal({ component_id: data.component, signal_type: data.type, message: msg, severity: 'HIGH' });
      }
      setStatus({ type: 'success', text: `Injected ${data.count} ${plural(data.count, 'signal')} successfully.` });
      onSent?.();
    } catch (err) {
      setStatus({ type: 'error', text: errorMessage(err, 'Injection failed.') });
    } finally { setLoading(false); }
  };

  return (
    <form className="panel injector" onSubmit={handleInject}>
      <h1 className="page-title">Signal injector</h1>
      <p className="injector-sub">Simulate infrastructure events</p>

      <div className="note-warn"><p>Admin/SRE only. Sends real signals to the ingestion pipeline.</p></div>

      <div className="injector-fields">
        <div className="injector-pair">
          <Field label="Component">
            {id => (
              <select id={id} value={data.component} onChange={e => setData({ ...data, component: e.target.value })}>
                {COMPONENTS.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            )}
          </Field>
          <Field label="Signal Type">
            {id => (
              <select id={id} value={data.type} onChange={e => setData({ ...data, type: e.target.value })}>
                {SIGNAL_TYPES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            )}
          </Field>
        </div>

        <Field label="Message (optional)">
          {id => <input id={id} maxLength={4096} placeholder={defaultMessage} value={data.message} onChange={e => setData({ ...data, message: e.target.value })} />}
        </Field>

        <div role="group" aria-labelledby="batch-count-label">
          <span className="field-label" id="batch-count-label">Batch Count</span>
          <div className="stepper">
            <button type="button" className="step-btn" aria-label="Decrease count" onClick={() => setData({ ...data, count: Math.max(1, data.count - 1) })}>−</button>
            <span className="step-value" aria-live="polite">{data.count}</span>
            <button type="button" className="step-btn" aria-label="Increase count" onClick={() => setData({ ...data, count: Math.min(100, data.count + 1) })}>+</button>
          </div>
        </div>

        <button type="submit" disabled={loading} className="btn btn-secondary inject-submit">
          {loading ? <span className="spinner" /> : `Inject ${data.count > 1 ? data.count + ' Signals' : 'Signal'}`}
        </button>

        {status && <div className="inject-status" data-status={status.type}>{status.text}</div>}
      </div>
    </form>
  );
}
