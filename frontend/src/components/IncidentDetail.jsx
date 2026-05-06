import React, { useState, useEffect } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { PriorityBadge, StatusBadge } from './Badges';
import { RCAForm } from './RCAForm';
import { CommentsSection } from './CommentsSection';
import { fetchWorkItem, fetchSignals, fetchRCA, updateStatus, assignWorkItem, listUsers } from '../api/client';
import { useAuth } from '../context/AuthContext';

function avatarColor(name = '') {
  const hash = [...name].reduce((acc, c) => c.charCodeAt(0) + ((acc << 5) - acc), 0);
  return `hsl(${Math.abs(hash) % 360}, 60%, 55%)`;
}

function fmtMTTR(s) {
  if (!s) return null;
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}

function SlaChip({ deadline, status }) {
  const [now, setNow] = useState(new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t); }, []);
  if (!deadline || ['RESOLVED', 'CLOSED'].includes(status)) return null;
  const diff = new Date(deadline) - now;
  if (diff <= 0) return <span style={{ padding: '4px 12px', borderRadius: 20, background: 'var(--p0-bg)', color: 'var(--p0-color)', fontSize: 11, fontWeight: 700, animation: 'pulse 1.5s infinite' }}>SLA BREACHED</span>;
  const h = Math.floor(diff / 3600000), m = Math.floor((diff % 3600000) / 60000), s = Math.floor((diff % 60000) / 1000);
  const col = diff < 300000 ? 'var(--p0-color)' : diff < 1800000 ? 'var(--p2-color)' : 'var(--p3-color)';
  const bg  = diff < 300000 ? 'var(--p0-bg)' : diff < 1800000 ? 'var(--p2-bg)' : 'var(--p3-bg)';
  return <span style={{ padding: '4px 12px', borderRadius: 20, background: bg, color: col, fontSize: 11, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>SLA {h > 0 ? `${h}h ` : ''}{m}m {s}s</span>;
}

export function IncidentDetail({ id, onRefresh }) {
  const { user } = useAuth();
  const [incident, setIncident]       = useState(null);
  const [signals, setSignals]         = useState([]);
  const [users, setUsers]             = useState([]);
  const [rcaExists, setRcaExists]     = useState(false);
  const [signalsOpen, setSignalsOpen] = useState(false);
  const [transitioning, setTransit]   = useState(null);
  const [loading, setLoading]         = useState(false);

  const load = async () => {
    if (!id) return;
    setLoading(true);
    try {
      // FIX: use fetchWorkItem → /api/work-items/:id (not /api/incidents/:id)
      const wi = await fetchWorkItem(id);
      setIncident(wi);
      // supplementary — don't block main load
      fetchSignals(id).then(setSignals).catch(() => {});
      listUsers().then(setUsers).catch(() => {});
      fetchRCA(id).then(r => setRcaExists(!!r)).catch(() => {});
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); setIncident(null); }, [id]);

  const doTransition = async (newStatus) => {
    if (newStatus === 'CLOSED' && !rcaExists) return;
    setTransit(newStatus);
    try {
      // FIX: updateStatus → PATCH /api/work-items/:id/status
      await updateStatus(id, newStatus);
      await load(); onRefresh?.();
    } catch (e) { console.error(e); }
    finally { setTransit(null); }
  };

  if (!id) return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'var(--text-tertiary)', gap: 12 }}>
      <div style={{ fontSize: 64, opacity: 0.15 }}>∅</div>
      <h3 style={{ fontSize: 18, fontWeight: 600, color: 'var(--text-secondary)' }}>Select an incident</h3>
      <p style={{ fontSize: 13 }}>Real-time telemetry will appear here.</p>
    </div>
  );

  if (loading && !incident) return (
    <div style={{ padding: 32, display: 'flex', flexDirection: 'column', gap: 14 }}>
      {[200, 140, 100].map((w, i) => <div key={i} className="shimmer" style={{ height: 20, width: w }} />)}
    </div>
  );

  if (!incident) return null;

  const assignedUser = users.find(u => u.id === incident.assignee_id);
  const mttr = fmtMTTR(incident.mttr_seconds);
  const transitions = { OPEN: ['INVESTIGATING'], INVESTIGATING: ['RESOLVED'], RESOLVED: ['CLOSED'], CLOSED: [] }[incident.status] || [];
  const transStyle = {
    INVESTIGATING: { bg: 'var(--p2-bg)', color: 'var(--p2-color)', label: 'Start Investigating' },
    RESOLVED:      { bg: 'var(--p3-bg)', color: 'var(--success)',   label: 'Mark Resolved' },
    CLOSED:        { bg: 'var(--bg-raised)', color: 'var(--text-secondary)', label: 'Close Incident' },
  };

  return (
    <div style={{ padding: '28px 32px', overflowY: 'auto', height: '100%', animation: 'slideDown 0.3s' }}>

      {/* Header card */}
      <div className="glass" style={{ padding: 24, borderRadius: 16, marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
          <PriorityBadge priority={incident.priority} />
          <StatusBadge status={incident.status} />
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
            {mttr && <span style={{ padding: '4px 10px', borderRadius: 6, background: 'var(--p3-bg)', color: 'var(--success)', fontSize: 11, fontWeight: 600 }}>MTTR: {mttr}</span>}
            <SlaChip deadline={incident.sla_deadline} status={incident.status} />
          </div>
        </div>

        {/* FIX: component_id, not component */}
        <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 4 }}>{incident.component_id}</h1>
        <p style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-tertiary)', marginBottom: 20, fontVariantNumeric: 'tabular-nums' }}>
          #{incident.id} · Created {formatDistanceToNow(new Date(incident.created_at), { addSuffix: true })}
        </p>

        {/* Assignee */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
          {assignedUser ? (
            <>
              <div style={{ width: 24, height: 24, borderRadius: '50%', background: avatarColor(assignedUser.username), color: '#fff', fontSize: 10, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {assignedUser.username[0].toUpperCase()}
              </div>
              <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Assigned to <strong style={{ color: 'var(--text-primary)' }}>{assignedUser.username}</strong></span>
            </>
          ) : (
            <select onChange={e => { if (e.target.value) assignWorkItem(id, e.target.value).then(load); }} defaultValue="" style={{ width: 'auto', maxWidth: 220 }}>
              <option value="" disabled>Unassigned — assign to…</option>
              {users.map(u => <option key={u.id} value={u.id}>{u.username} ({u.role})</option>)}
            </select>
          )}
        </div>

        {/* Transition buttons */}
        {transitions.length > 0 && (
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {transitions.map(st => {
              const s = transStyle[st];
              const blocked = st === 'CLOSED' && !rcaExists;
              return (
                <button key={st} onClick={() => doTransition(st)} disabled={!!transitioning || blocked} title={blocked ? 'Submit RCA first' : ''} style={{ height: 36, padding: '0 20px', background: blocked ? 'transparent' : s.bg, color: blocked ? 'var(--text-tertiary)' : s.color, border: `1px solid ${blocked ? 'var(--border-default)' : 'transparent'}`, borderRadius: 20, fontSize: 13, fontWeight: 500, opacity: blocked ? 0.5 : 1 }}>
                  {transitioning === st ? <span className="spinner" /> : s.label}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Signals */}
      <div style={{ marginBottom: 20 }}>
        <div onClick={() => setSignalsOpen(o => !o)} style={{ display: 'flex', alignItems: 'center', cursor: 'pointer', marginBottom: signalsOpen ? 12 : 0, gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)' }}>Signals ({signals.length})</span>
          <span style={{ fontSize: 10, display: 'inline-block', transition: 'transform 0.2s', transform: signalsOpen ? 'rotate(90deg)' : 'none', color: 'var(--text-tertiary)' }}>›</span>
        </div>
        {signalsOpen && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, animation: 'slideDown 0.2s' }}>
            {signals.map((s, i) => (
              <div key={s.id || i} style={{ background: 'var(--bg-raised)', padding: '6px 12px', borderRadius: 8, fontSize: 11, border: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ color: 'var(--p0-color)' }}>●</span>
                {/* FIX: signal_type not type */}
                {s.signal_type} · {formatDistanceToNow(new Date(s.created_at), { addSuffix: true })}
              </div>
            ))}
            {signals.length === 0 && <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>No signals yet.</span>}
          </div>
        )}
      </div>

      <div style={{ borderTop: '1px solid var(--border-subtle)', marginBottom: 20 }} />
      <div style={{ marginBottom: 20 }}>
        <RCAForm workItem={incident} onSuccess={() => { setRcaExists(true); load(); onRefresh?.(); }} />
      </div>
      <div style={{ borderTop: '1px solid var(--border-subtle)', marginBottom: 20 }} />
      {/* FIX: pass id (number/string), not incident.id via wiId */}
      <CommentsSection wiId={id} />
    </div>
  );
}
