import { useState } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { PriorityBadge, StatusBadge } from './Badges';
import { RCAForm } from './RCAForm';
import { CommentsSection } from './CommentsSection';
import { ErrorNote } from './ErrorNote';
import {
  fetchWorkItem, fetchSignals, fetchRCA, updateStatus, assignWorkItem, listUsers, errorMessage,
} from '../api/client';
import { useAuth, canWrite } from '../context/auth';
import { useQuery } from '../hooks/useQuery';
import { useNow } from '../hooks/useNow';
import { avatarColor, fmtMTTR } from '../format';

const NEXT = { OPEN: ['INVESTIGATING'], INVESTIGATING: ['RESOLVED'], RESOLVED: ['CLOSED'], CLOSED: [] };
const TRANSITION_LABEL = { INVESTIGATING: 'Start Investigating', RESOLVED: 'Mark Resolved', CLOSED: 'Close Incident' };
const SEVERITY_LEVEL = { CRITICAL: 'p0', HIGH: 'p1', MEDIUM: 'p2', LOW: 'p3' };

function SlaChip({ deadline, status }) {
  const now = useNow();
  if (!deadline || ['RESOLVED', 'CLOSED'].includes(status)) return null;
  const diff = new Date(deadline) - now;
  if (diff <= 0) return <span className="sla-chip breached" data-level="p0">SLA BREACHED</span>;
  const h = Math.floor(diff / 3600000), m = Math.floor((diff % 3600000) / 60000), s = Math.floor((diff % 60000) / 1000);
  const level = diff < 300000 ? 'p0' : diff < 1800000 ? 'p2' : 'p3';
  return <span className="sla-chip" data-level={level}>SLA {h > 0 ? `${h}h ` : ''}{m}m {s}s</span>;
}

export function IncidentDetail({ id, onRefresh, refreshTick }) {
  const { user } = useAuth();
  const write = canWrite(user);
  const [signalsOpen, setSignalsOpen] = useState(false);
  const [transitioning, setTransit] = useState(null);
  const [actionError, setActionError] = useState('');

  const wi = useQuery(id, () => fetchWorkItem(id), refreshTick);
  const signals = useQuery(id, () => fetchSignals(id), refreshTick);
  const rca = useQuery(id, () => fetchRCA(id), refreshTick);
  // Only people who can assign need the user list (viewers get a 403 for it).
  const users = useQuery(write ? 'users' : null, listUsers);

  // A mutation returns the updated work item, so render it instead of refetching.
  const mutate = async (call) => {
    setActionError('');
    try {
      wi.setData(await call());
      onRefresh?.();
    } catch (e) {
      setActionError(errorMessage(e, 'Action failed'));
    }
  };
  const doTransition = async (status) => {
    setTransit(status);
    await mutate(() => updateStatus(id, status));
    setTransit(null);
  };

  if (!id) return (
    <div className="empty-state detail-empty">
      <div className="empty-mark">∅</div>
      <h3>Select an incident</h3>
      <p>Real-time telemetry will appear here.</p>
    </div>
  );

  const incident = wi.data;
  if (!incident) {
    if (wi.error) return <div className="detail"><ErrorNote>{errorMessage(wi.error, 'Could not load incident')}</ErrorNote></div>;
    return (
      <div className="detail-skeleton">
        {[200, 140, 100].map((w, i) => <div key={i} className="shimmer" style={{ height: 20, width: w }} />)}
      </div>
    );
  }

  const mttr = fmtMTTR(incident.mttr_seconds);
  const transitions = write ? NEXT[incident.status] || [] : [];
  const signalList = signals.data ?? [];
  // Viewers cannot act on an incident, so only SREs and admins are offered.
  const assignable = (users.data ?? []).filter(u => u.role !== 'viewer');

  return (
    <div className="detail">
      <div className="glass detail-card">
        <div className="detail-badges">
          <PriorityBadge priority={incident.priority} />
          <StatusBadge status={incident.status} />
          <div className="detail-badges-right">
            {mttr && <span className="mttr-chip">MTTR: {mttr}</span>}
            <SlaChip deadline={incident.sla_deadline} status={incident.status} />
          </div>
        </div>

        <h1>{incident.component}</h1>
        <p className="detail-meta">
          #{incident.id} · Created {formatDistanceToNow(new Date(incident.created_at), { addSuffix: true })}
        </p>

        <div className="assignee">
          {incident.assignee_username && (
            <div className="avatar avatar-lg" style={{ background: avatarColor(incident.assignee_username) }}>
              {incident.assignee_username[0].toUpperCase()}
            </div>
          )}
          {write ? (
            <select name="assignee" aria-label="Assign to" className="assign-select" value={incident.assignee_id ?? ''}
              onChange={e => mutate(() => assignWorkItem(id, e.target.value || null))}>
              <option value="">Unassigned</option>
              {incident.assignee_id && !assignable.some(u => u.id === incident.assignee_id) && (
                <option value={incident.assignee_id}>{incident.assignee_username}</option>
              )}
              {assignable.map(u => <option key={u.id} value={u.id}>{u.username} ({u.role})</option>)}
            </select>
          ) : incident.assignee_username ? (
            <span className="assignee-text">Assigned to <strong>{incident.assignee_username}</strong></span>
          ) : (
            <span className="assignee-text">Unassigned</span>
          )}
        </div>

        {transitions.length > 0 && (
          <div className="transitions">
            {transitions.map(st => {
              const blocked = st === 'CLOSED' && !rca.data;
              return (
                <button type="button" key={st} className="transition-btn" data-to={st} data-blocked={blocked}
                  onClick={() => doTransition(st)} disabled={!!transitioning || blocked}
                  title={blocked ? 'Submit RCA first' : ''}>
                  {transitioning === st ? <span className="spinner" /> : TRANSITION_LABEL[st]}
                </button>
              );
            })}
          </div>
        )}
        {actionError && <ErrorNote>{actionError}</ErrorNote>}
      </div>

      <div className="signals">
        <button type="button" className="btn-bare signals-toggle" aria-expanded={signalsOpen}
          onClick={() => setSignalsOpen(o => !o)}>
          <span className="signals-title">Signals ({signalList.length})</span>
          <span className="signals-caret" aria-hidden="true">›</span>
        </button>
        {signalsOpen && (
          <div className="signal-list">
            {signalList.map(s => (
              <div key={s.id} className="signal">
                <span className="signal-dot" data-level={SEVERITY_LEVEL[s.severity] ?? 'p2'} aria-hidden="true">●</span>
                <span className="signal-msg">{s.message}</span>
                <span className="signal-meta">
                  {[s.severity, s.timestamp && formatDistanceToNow(new Date(s.timestamp), { addSuffix: true })].filter(Boolean).join(' · ')}
                </span>
              </div>
            ))}
            {signalList.length === 0 && <span className="muted">No signals yet.</span>}
          </div>
        )}
      </div>

      <hr className="divider" />
      <div className="detail-section">
        {!rca.loading && (
          <RCAForm workItem={incident} rca={rca.data} readOnly={!write}
            onSuccess={(created) => { rca.setData(created); onRefresh?.(); }} />
        )}
      </div>
      <hr className="divider" />
      <CommentsSection wiId={id} refreshTick={refreshTick} />
    </div>
  );
}
