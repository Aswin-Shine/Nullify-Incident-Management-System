import { useState, useEffect, useRef, useId } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { Tabs } from '@heroui/react';
import { PriorityBadge, StatusBadge } from './Badges';
import { RCAForm } from './RCAForm';
import { CommentsSection } from './CommentsSection';
import { ErrorNote } from './ErrorNote';
import { Icon } from './Icon';
import {
  fetchWorkItem, fetchSignals, fetchRCA, fetchHistory, updateStatus, assignWorkItem, listUsers, errorMessage,
} from '../api/client';
import { useAuth, canWrite } from '../context/auth';
import { useToast } from '../context/toast';
import { useQuery } from '../hooks/useQuery';
import { useNow } from '../hooks/useNow';
import { fmtMTTR, fmtStamp, toLocalInput, signalRate, breachAge, breachLevel, startedMessage, copyIncidentLink, rcaDue, shortAge } from '../format';

const NEXT = { OPEN: ['INVESTIGATING'], INVESTIGATING: ['RESOLVED'], RESOLVED: ['CLOSED'], CLOSED: [] };
const TRANSITION_LABEL = { INVESTIGATING: 'Start investigating', RESOLVED: 'Mark resolved', CLOSED: 'Close incident…' };
const ACTIVE = ['OPEN', 'INVESTIGATING'];  // while active the Signals tab opens first; afterwards the RCA tab does
const FINISHED = ['RESOLVED', 'CLOSED'];
const SIGNALS_SHOWN = 5;
const LIVE_MS = 15 * 60000;  // a signal group is "live" (its rate still means something) while its last signal is this recent

// One row per (message, severity), newest group first. `newestFirst` lists the signals newest first, so the first
// signal met for a key is its latest and the last one met is its earliest.
function groupSignals(newestFirst) {
  const groups = new Map();
  for (const s of newestFirst) {
    const key = `${s.severity}|${s.message}`;
    const g = groups.get(key);
    if (g) { g.count += 1; g.first = s.timestamp; } else groups.set(key, { key, message: s.message, severity: s.severity, count: 1, first: s.timestamp, last: s.timestamp });
  }
  return [...groups.values()];
}

// "HIGH · last 2 minutes ago · since Sep 29, 05:23 · ≈ 4/min". The rate only shows while the group is live.
function SignalMeta({ g }) {
  const now = useNow();
  return (
    <span className="signal-meta">
      {[
        g.severity,
        g.last && `last ${formatDistanceToNow(new Date(g.last), { addSuffix: true })}`,
        g.count > 1 && g.first && `since ${fmtStamp(g.first)}`,
        g.count > 1 && now - new Date(g.last) < LIVE_MS && signalRate(g.count, g.first, g.last),
      ].filter(Boolean).join(' · ')}
    </span>
  );
}

// The one-line state of an active incident: "P0 · SLA breached 5d 5h ago · no owner". Red marks only what needs
// action now: a breach under an hour old, and no owner on a P0. The SLA part is left out when there is no deadline.
function StateLine({ incident }) {
  const now = useNow();
  const { priority, sla_deadline: deadline, assignee_username: owner } = incident;
  const diff = deadline ? new Date(deadline) - now : null;
  let sla = null;
  if (diff != null && diff <= 0) {
    const level = breachLevel(deadline, now) === 'p0' ? 'p0' : undefined;
    sla = <span key="sla" className="state-sla" data-level={level}>SLA breached {breachAge(deadline, now).slice(1)} ago</span>;  // slice drops the "+"
  } else if (diff != null) {
    const h = Math.floor(diff / 3600000), m = Math.floor((diff % 3600000) / 60000), s = Math.floor((diff % 60000) / 1000);
    sla = <span key="sla" className="state-sla">SLA due in {h > 0 ? `${h}h ${m}m` : `${m}m ${s}s`}</span>;
  }
  const parts = [
    <span key="pri" className="state-pri">{priority}</span>,
    sla,
    <span key="owner" className="state-owner" data-level={!owner && priority === 'P0' ? 'p0' : undefined}>{owner ? `owned by ${owner}` : 'no owner'}</span>,
  ].filter(Boolean);
  return <p className="state-line">{parts.flatMap((p, i) => i ? [' · ', p] : [p])}</p>;
}

// A resolved incident still waiting for its RCA: "Resolved 3d ago · RCA overdue by 1d 3h" (or "RCA due in 1d 23h").
function RcaLine({ incident }) {
  const due = rcaDue(incident, useNow());
  if (!due) return null;
  return (
    <p className="state-line">
      Resolved {shortAge(incident.resolved_at)} ago · {due.overdue ? `RCA overdue by ${due.long}` : `RCA due in ${due.long}`}
    </p>
  );
}

// `onResolve(incident, note)` starts the owner's undoable resolve once the note form is filled; `resolving` says one is
// pending for this incident. A new `askNote` ({ id }) object opens the note form when it names this incident (the palette).
// `onOpened({ id, component, status, assignee_id })` reports the incident that loaded, for the list's note and the tab title.
// `onClose` deselects the incident (the card's ✕; App also maps Escape to it).
export function IncidentDetail({ id, onRefresh, refreshTick, onResolve, resolving = false, onOpened, onClose, askNote }) {
  const { user } = useAuth();
  const write = canWrite(user);
  // The user's own tab choice and "Show all" for one incident; any other incident starts at the defaults for its status.
  const [tabView, setTabView] = useState({ id: null, key: null });
  const [allSignalsFor, setAllSignalsFor] = useState(null);
  const [transitioning, setTransit] = useState(null);
  const [assigningId, setAssigningId] = useState(null);  // the incident whose assignment request is in flight
  const [confirmId, setConfirmId] = useState(null);  // the incident whose Close is awaiting confirmation
  const [noteFor, setNoteFor] = useState(null);  // the incident whose resolution note form is open
  const [draft, setDraft] = useState({ id: null, text: '' });  // kept after submit, so an undone resolve keeps its note
  const [seenAsk, setSeenAsk] = useState(askNote);  // an ask already present at mount is old news
  if (askNote !== seenAsk) {
    setSeenAsk(askNote);
    if (askNote?.id === id) setNoteFor(id);
  }
  const noteId = useId();
  const noteRef = useRef(null);
  const resolveRef = useRef(null);
  const wasNoting = useRef(false);
  const cancelRef = useRef(null);
  const closeRef = useRef(null);
  const wasConfirming = useRef(false);
  const h1Ref = useRef(null);
  const toast = useToast();

  const wi = useQuery(id, () => fetchWorkItem(id), refreshTick);
  const signals = useQuery(id, () => fetchSignals(id), refreshTick);
  const rca = useQuery(id, () => fetchRCA(id), refreshTick);
  // A finished incident names who resolved and who closed it, from the status events. Active ones have nothing to read yet.
  const history = useQuery(FINISHED.includes(wi.data?.status) ? `${id}:history` : null, () => fetchHistory(id), refreshTick);
  // Only people who can assign need the user list (viewers get a 403 for it).
  const users = useQuery(write ? 'users' : null, listUsers);

  // Focus follows the inline confirm: Cancel when it opens, the Close button again when it is dismissed.
  const confirming = confirmId === id;
  useEffect(() => {
    if (confirming) cancelRef.current?.focus();
    else if (wasConfirming.current && confirmId === null) closeRef.current?.focus();  // not when the user moved to another incident
    wasConfirming.current = confirming;
  }, [confirming, confirmId]);
  // The same for the note form: the textarea when it opens, Mark resolved again when it is dismissed.
  const noting = noteFor === id;
  useEffect(() => {
    if (noting) noteRef.current?.focus();
    else if (wasNoting.current && noteFor === null) resolveRef.current?.focus();
    wasNoting.current = noting;
  }, [noting, noteFor]);
  // Below 900px the list is hidden once an incident is open, so the heading takes the focus.
  const loadedId = wi.data?.id;
  useEffect(() => { if (loadedId && window.innerWidth < 900) h1Ref.current?.focus(); }, [loadedId]);
  const loadedComponent = wi.data?.component, loadedStatus = wi.data?.status, loadedAssignee = wi.data?.assignee_id;
  useEffect(() => {
    if (loadedId) onOpened?.({ id: loadedId, component: loadedComponent, status: loadedStatus, assignee_id: loadedAssignee });
  }, [loadedId, loadedComponent, loadedStatus, loadedAssignee, onOpened]);

  // A mutation returns the updated work item, so render it instead of refetching.
  const mutate = async (call, successMessage) => {
    try {
      const updated = await call();
      wi.setData(updated);
      toast(successMessage(updated));
      onRefresh?.();
    } catch (e) {
      toast(errorMessage(e, 'Action failed'), { kind: 'error' });
    }
  };
  const doTransition = async (status, successMessage = updated => `Moved to ${updated.status}`) => {
    setTransit(status);
    await mutate(() => updateStatus(id, status), successMessage);
    setTransit(null);
  };
  // One assignment at a time: the controls stay disabled until the request settles, success or error.
  const assign = async (assigneeId) => {
    if (assigningId === id) return;
    setAssigningId(id);
    await mutate(() => assignWorkItem(id, assigneeId), assigned);
    setAssigningId(null);
  };
  // Starting an investigation claims an unowned incident for you; say so when the response shows it happened.
  const started = updated => startedMessage(wi.data, updated, user.id);
  const assigned = updated => updated.assignee_username ? `Assigned to ${updated.assignee_username}` : 'Incident unassigned';

  if (!id) return (
    <div className="empty-state detail-empty">
      <div className="empty-mark"><Icon name="null" size={32} /></div>
      <h3>Select an incident</h3>
      <p>Real-time telemetry will appear here.</p>
    </div>
  );

  const incident = wi.data;
  if (!incident) {
    if (wi.error) return <div className="detail"><ErrorNote onRetry={wi.reload}>{errorMessage(wi.error, 'Could not load incident')}</ErrorNote></div>;
    return (
      <div className="detail-skeleton">
        {[200, 140, 100].map((w, i) => <div key={i} className="shimmer" style={{ height: 20, width: w }} />)}
      </div>
    );
  }

  const mttr = fmtMTTR(incident.mttr_seconds);
  const closed = incident.status === 'CLOSED';
  const category = rca.data?.root_cause_category;
  const finished = FINISHED.includes(incident.status);
  // Who moved the incident to `status`; '-' when there is no such event (before migration 0004), no actor, or no history.
  const actorOf = (status) => history.data?.find(e => e.kind === 'status' && e.to_value === status)?.actor_username ?? '-';
  const completion = closed ? `Closed${mttr ? ` · MTTR ${mttr}` : ''}` : mttr ? `Resolved · MTTR ${mttr}` : null;
  const facts = [mttr && `MTTR ${mttr}`, category].filter(Boolean).join(' · ');
  const confirmText = `Close ${incident.component}?${facts ? ` ${facts}.` : ''} The RCA locks once closed.`;
  const transitions = write ? NEXT[incident.status] || [] : [];
  const noteText = draft.id === id ? draft.text : '';
  const submitNote = (e) => {
    e.preventDefault();
    if (!noteText.trim()) return;
    setNoteFor(null);
    onResolve?.(incident, noteText.trim());
  };
  const closeBlocked = transitions.includes('CLOSED') && !rca.data;  // also while the RCA could not be loaded: we cannot tell
  const signalList = signals.data ?? [];
  const active = ACTIVE.includes(incident.status);
  const claimFirst = write && incident.status === 'INVESTIGATING' && !incident.assignee_id;
  const tabKey = tabView.id === id ? tabView.key : active ? 'signals' : 'rca';
  const showAll = allSignalsFor === id;
  const newestFirst = [...signalList].reverse();  // the API sends the latest signals oldest first
  const latest = newestFirst[0];
  const groups = groupSignals(newestFirst);
  // Viewers cannot act on an incident, so only SREs and admins are offered.
  const assigning = assigningId === id;
  const assignable = (users.data ?? []).filter(u => u.role !== 'viewer');

  const signalsSection = (
    <div className="signal-list">
      {(showAll ? groups : groups.slice(0, SIGNALS_SHOWN)).map(g => (
        <div key={g.key} className="signal">
          <span className="signal-dot" data-level={g.severity === 'CRITICAL' ? 'p0' : undefined} aria-hidden="true" />
          <div className="signal-body">
            <div className="signal-top">
              <span className="signal-msg" dir="auto">{g.message}</span>
              <span className="signal-count">×{g.count.toLocaleString()}</span>
            </div>
            <SignalMeta g={g} />
          </div>
        </div>
      ))}
      {signalList.length === 0 && <span className="muted">No signals yet.</span>}
      {!showAll && groups.length > SIGNALS_SHOWN && (
        <button type="button" className="btn-link" onClick={() => setAllSignalsFor(id)}>
          Show all {groups.length} groups
        </button>
      )}
      {incident.signal_count > signalList.length && signalList.length > 0 && (
        <span className="muted-sm">showing the latest {signalList.length}</span>
      )}
    </div>
  );

  const rcaSection = (
    <div key="rca">
      {rca.error && !rca.data ? <ErrorNote>Could not load the RCA</ErrorNote> : !rca.loading && (
        <RCAForm key={incident.id} workItem={incident} rca={rca.data} readOnly={!write}
          defaultOpen={incident.status === 'RESOLVED'} locked={incident.status === 'OPEN'}
          onSuccess={(created) => { rca.setData(created); toast('RCA submitted'); onRefresh?.(); }} />
      )}
    </div>
  );

  const timelineSection = <CommentsSection key={`timeline:${id}`} wiId={id} refreshTick={refreshTick} />;

  return (
    <div className="detail" key={incident.id}>
      <div className="panel detail-card">
        {onClose && (
          <button type="button" className="deselect-btn" aria-label="Deselect incident" title="Deselect (Esc)" onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        )}
        {completion && (
          <p className="completion" title={mttr ? 'Time from the first signal to the RCA' : undefined}>
            <Icon name="check" size={16} />
            <span>{completion}</span>
            {mttr && <span className="sr-only">, time from the first signal to the RCA</span>}
          </p>
        )}
        <div className="detail-badges">
          <PriorityBadge priority={incident.priority} muted={finished} />
          {!completion && <StatusBadge status={incident.status} />}
        </div>

        <h1 ref={h1Ref} tabIndex={-1}>{incident.component}</h1>
        {active && <StateLine incident={incident} />}
        {!rca.data && <RcaLine incident={incident} />}
        <div className="detail-meta">
          <span className="detail-id" title={incident.id}>#{incident.id.slice(0, 8)}</span>
          <button type="button" className="btn-link copy-link" onClick={() => copyIncidentLink(incident.id, toast)}>
            <Icon name="link" size={12} />Copy link
          </button>
          {/* Created is news only when it differs from the first signal, to the minute */}
          {toLocalInput(incident.created_at) !== toLocalInput(incident.start_time) && (
            <span>Created {formatDistanceToNow(new Date(incident.created_at), { addSuffix: true })}</span>
          )}
        </div>

        <div className="detail-facts">
          <dl className="detail-summary">
            <div><dt>First signal</dt><dd>{fmtStamp(incident.start_time)}</dd></div>
            <div>
              <dt>Last signal</dt>
              <dd title={fmtStamp(incident.last_signal_at)}>
                {incident.last_signal_at ? formatDistanceToNow(new Date(incident.last_signal_at), { addSuffix: true }) : '-'}
              </dd>
            </div>
            <div><dt>Signals</dt><dd>{(incident.signal_count ?? signalList.length).toLocaleString()}</dd></div>
            {finished && <div><dt>Resolved by</dt><dd>{actorOf('RESOLVED')}</dd></div>}
            {closed && <div><dt>Closed by</dt><dd>{actorOf('CLOSED')}</dd></div>}
          </dl>
          {finished && incident.resolution_note && (
            <div className="detail-latest detail-resolution">
              <span className="micro">Resolution</span>
              <p dir="auto">{incident.resolution_note}</p>
            </div>
          )}
          {latest && !closed && (
            <div className="detail-latest">
              <span className="micro">Latest</span>
              <p title={latest.message} dir="auto">{latest.message}</p>
            </div>
          )}
        </div>

        {!closed && (
          <div className="action-bar">
            <div className="assignee">
              {incident.assignee_username && (
                <div className="avatar avatar-lg">
                  {incident.assignee_username[0].toUpperCase()}
                </div>
              )}
              {write ? (
                <select name="assignee" aria-label="Assign to" className="assign-select" value={incident.assignee_id ?? ''} disabled={assigning}
                  onChange={e => assign(e.target.value || null)}>
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
              {write && incident.assignee_id !== user.id && (
                <button type="button" className={claimFirst ? 'btn btn-primary assign-me' : 'btn-link assign-me'} disabled={assigning} onClick={() => assign(user.id)}>
                  Assign to me
                </button>
              )}
            </div>

            {transitions.length > 0 && (noting && transitions.includes('RESOLVED') ? (
              // Escape cancels the form; the keys themselves land on the textarea and buttons inside it.
              // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
              <form className="close-confirm resolve-form" onSubmit={submitNote}
                onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); setNoteFor(null); } }}>
                <label htmlFor={noteId}>How was it resolved?</label>
                <textarea id={noteId} ref={noteRef} rows={3} maxLength={4000} required value={noteText}
                  placeholder="What fixed it, in a sentence or two. The RCA comes later."
                  onChange={e => setDraft({ id, text: e.target.value })} />
                <div className="close-confirm-actions">
                  <button type="button" className="btn btn-secondary" onClick={() => setNoteFor(null)}>Cancel</button>
                  <button type="submit" className="btn btn-primary" disabled={!noteText.trim()}>Mark resolved</button>
                </div>
              </form>
            ) : confirming ? (
              // An inline confirm, not a modal: Close is final, but nothing here needs protected focus.
              // eslint-disable-next-line jsx-a11y/no-static-element-interactions
              <div className="close-confirm" onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); setConfirmId(null); } }}>
                <p>{confirmText}</p>
                <div className="close-confirm-actions">
                  <button type="button" ref={cancelRef} className="btn btn-secondary" onClick={() => setConfirmId(null)}>Cancel</button>
                  <button type="button" className="btn btn-primary" disabled={!!transitioning}
                    onClick={async () => {
                      await doTransition('CLOSED', updated => `Closed ${updated.component}${fmtMTTR(updated.mttr_seconds) ? ` · MTTR ${fmtMTTR(updated.mttr_seconds)}` : ''}`);
                      setConfirmId(null);
                    }}>
                    {transitioning === 'CLOSED' ? <span className="spinner" /> : 'Close incident'}
                  </button>
                </div>
              </div>
            ) : (
              <div className="transitions">
                {transitions.map(st => {
                  const blocked = st === 'CLOSED' && closeBlocked;
                  const pendingResolve = st === 'RESOLVED' && resolving;
                  // Claiming comes first: while nobody owns an investigation, Assign to me leads and Resolve steps back.
                  const secondary = st === 'RESOLVED' && claimFirst;
                  return (
                    <button type="button" key={st} ref={st === 'CLOSED' ? closeRef : st === 'RESOLVED' ? resolveRef : undefined} className={`btn ${secondary ? 'btn-secondary' : 'btn-primary'} transition-btn`} data-to={st} data-blocked={blocked}
                      onClick={() => st === 'CLOSED' ? setConfirmId(id) : st === 'RESOLVED' ? setNoteFor(id) : doTransition(st, st === 'INVESTIGATING' ? started : undefined)}
                      disabled={!!transitioning || blocked || pendingResolve}>
                      {transitioning === st ? <span className="spinner" /> : pendingResolve ? 'Resolving…' : TRANSITION_LABEL[st]}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        )}
        {closeBlocked && !rca.loading && (
          <p className="transition-hint">{rca.error ? 'Could not check the RCA.' : 'Submit the RCA to close.'}</p>
        )}
      </div>

      {/* Signals, Activity and RCA as tabs instead of one long stack; the open tab follows the state. Activity and RCA
          stay mounted while hidden, so an unsent comment or RCA draft survives a tab switch. */}
      <Tabs className="detail-tabs" selectedKey={tabKey} onSelectionChange={key => setTabView({ id, key })}>
        <Tabs.ListContainer>
          <Tabs.List aria-label="Incident sections">
            <Tabs.Tab id="signals">Signals <span className="tab-count">{(incident.signal_count ?? signalList.length).toLocaleString()}</span><Tabs.Indicator /></Tabs.Tab>
            <Tabs.Tab id="activity">Activity<Tabs.Indicator /></Tabs.Tab>
            <Tabs.Tab id="rca">RCA<Tabs.Indicator /></Tabs.Tab>
          </Tabs.List>
        </Tabs.ListContainer>
        <Tabs.Panel id="signals" className="detail-panel">{signalsSection}</Tabs.Panel>
        <Tabs.Panel id="activity" className="detail-panel" shouldForceMount><div hidden={tabKey !== 'activity'}>{timelineSection}</div></Tabs.Panel>
        <Tabs.Panel id="rca" className="detail-panel" shouldForceMount><div hidden={tabKey !== 'rca'}>{rcaSection}</div></Tabs.Panel>
      </Tabs>
    </div>
  );
}
