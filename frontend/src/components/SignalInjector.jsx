import { useState } from 'react';
import { ingestSignal } from '../api/client';

const COMPONENTS = [
  'RDBMS_PRIMARY', 'RDBMS_REPLICA', 'CACHE_CLUSTER_01',
  'KAFKA_BROKER_01', 'API_GATEWAY', 'MCP_HOST_01',
  'POSTGRES_MAIN', 'REDIS_CACHE', 'SQS_QUEUE_01',
];

const SIGNAL_TYPES = ['ERROR', 'LATENCY_SPIKE', 'TIMEOUT', 'CONNECTION_REFUSED', 'OOM', 'DISK_FULL'];

export function SignalInjector({ onSent }) {
  const [component, setComponent] = useState(COMPONENTS[0]);
  const [signalType, setSignalType] = useState(SIGNAL_TYPES[0]);
  const [message, setMessage] = useState('');
  const [count, setCount] = useState(1);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState('');

  const send = async () => {
    setSending(true); setResult('');
    try {
      const msg = message || `${signalType} detected on ${component}`;
      for (let i = 0; i < count; i++) {
        await ingestSignal({ component_id: component, signal_type: signalType, message: msg, severity: 'HIGH' });
      }
      setResult(`✓ Sent ${count} signal(s)`);
      onSent?.();
    } catch (e) {
      setResult('✗ ' + (e.response?.data?.detail || 'Failed'));
    } finally { setSending(false); }
  };

  const simulateOutage = async () => {
    setSending(true); setResult('');
    const scenarios = [
      { component_id: 'RDBMS_PRIMARY', signal_type: 'CONNECTION_REFUSED', message: 'Primary DB unresponsive', severity: 'CRITICAL' },
      { component_id: 'RDBMS_REPLICA', signal_type: 'REPLICATION_LAG', message: 'Replica lag >30s', severity: 'HIGH' },
      { component_id: 'MCP_HOST_01', signal_type: 'ERROR', message: 'MCP host failing after DB outage', severity: 'HIGH' },
      { component_id: 'API_GATEWAY', signal_type: 'LATENCY_SPIKE', message: '5xx rate elevated', severity: 'MEDIUM' },
    ];
    try {
      for (const s of scenarios) await ingestSignal(s);
      setResult('✓ RDBMS→MCP outage simulated (4 signals)');
      onSent?.();
    } catch (e) { setResult('✗ Simulation failed'); }
    finally { setSending(false); }
  };

  return (
    <div style={{ padding: 16 }}>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-2)', letterSpacing: '0.1em', marginBottom: 12 }}>
        SIGNAL INJECTOR
      </div>
      <div style={{ display: 'grid', gap: 8 }}>
        <div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-2)', marginBottom: 3 }}>COMPONENT</div>
          <select value={component} onChange={e => setComponent(e.target.value)}>
            {COMPONENTS.map(c => <option key={c}>{c}</option>)}
          </select>
        </div>
        <div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-2)', marginBottom: 3 }}>SIGNAL TYPE</div>
          <select value={signalType} onChange={e => setSignalType(e.target.value)}>
            {SIGNAL_TYPES.map(s => <option key={s}>{s}</option>)}
          </select>
        </div>
        <div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-2)', marginBottom: 3 }}>MESSAGE</div>
          <input placeholder="optional custom message" value={message} onChange={e => setMessage(e.target.value)} />
        </div>
        <div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-2)', marginBottom: 3 }}>COUNT</div>
          <input type="number" min={1} max={500} value={count} onChange={e => setCount(parseInt(e.target.value) || 1)} />
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button onClick={send} disabled={sending}
          style={{
            flex: 1, padding: '8px', borderRadius: 3, fontSize: 11,
            background: 'var(--accent-bg)', color: 'var(--accent-hover)',
            border: '1px solid var(--accent)', opacity: sending ? 0.5 : 1,
          }}>
          {sending ? 'SENDING...' : 'INJECT'}
        </button>
        <button onClick={simulateOutage} disabled={sending}
          style={{
            flex: 1, padding: '8px', borderRadius: 3, fontSize: 11,
            background: 'var(--p0-bg)', color: 'var(--p0)',
            border: '1px solid var(--p0)44', opacity: sending ? 0.5 : 1,
          }}>
          SIMULATE OUTAGE
        </button>
      </div>
      {result && (
        <div style={{ marginTop: 8, fontFamily: 'var(--mono)', fontSize: 11, color: result.startsWith('✓') ? 'var(--p3)' : 'var(--p0)' }}>
          {result}
        </div>
      )}
    </div>
  );
}
