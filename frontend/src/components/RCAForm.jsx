import { useState } from 'react';
import { submitRCA, errorMessage } from '../api/client';
import { toLocalInput, rcaToMarkdown, fmtStamp } from '../format';
import { ErrorNote } from './ErrorNote';
import { Field } from './Field';
import { Icon } from './Icon';

const CATEGORIES = [
  'Infrastructure Failure',
  'Code Defect',
  'Configuration Error',
  'Dependency Outage',
  'Capacity Exhaustion',
  'Security Incident',
  'Human Error',
  'Unknown',
];

const MAX_TEXT = 8000;  // the backend limit for each free-text field

const ReadVal = ({ label, value }) => (
  <div>
    <span className="read-label">{label}</span>
    <div className="read-value" dir="auto">{value || '-'}</div>
  </div>
);

// The impact window starts as the incident's own first and last signal times; the SRE adjusts it.
const initialForm = (wi) => ({
  incident_start: toLocalInput(wi.start_time),
  incident_end: toLocalInput(wi.last_signal_at ?? wi.start_time),
  root_cause_category: '', fix_applied: '', prevention_steps: '',
});

// The saved impact window against the first signal, at the minute (the form pre-fills the start cut to the minute,
// so an untouched default is not a mistake). One line per side that falls before it.
function windowWarnings(rca, startTime) {
  if (!startTime) return [];
  const first = toLocalInput(startTime);
  const before = (iso) => { const at = toLocalInput(iso); return at !== '' && at < first; };
  const when = fmtStamp(startTime);
  return [
    before(rca.incident_start) && `This impact window starts before the first signal (${when}).`,
    before(rca.incident_end) && `This impact window ends before the first signal (${when}).`,
  ].filter(Boolean);
}

function downloadMarkdown(wi, rca) {
  const url = URL.createObjectURL(new Blob([rcaToMarkdown(wi, rca)], { type: 'text/markdown' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `rca-${wi.component.replace(/[^A-Za-z0-9_.-]/g, '_')}-${new Date().toISOString().slice(0, 10)}.md`;
  a.click();
  URL.revokeObjectURL(url);
}

// `rca` is the submitted RCA (or null); the parent owns fetching it. `readOnly` hides the form from viewers.
// `defaultOpen` false keeps the form behind a "Write RCA" button; `locked` replaces it with a line saying why it
// is not available yet (an OPEN incident cannot take an RCA).
export function RCAForm({ workItem, rca, onSuccess, readOnly = false, defaultOpen = true, locked = false }) {
  const [expanded, setExpanded] = useState(false);  // the user's click, so a later default-open (RESOLVED) keeps typed text
  const open = defaultOpen || expanded;
  const [formData, setFormData] = useState(() => initialForm(workItem));
  // Compared as local "YYYY-MM-DDTHH:mm" strings: the pre-filled start is the first signal cut to the minute.
  const beforeFirstSignal = formData.incident_start && workItem.start_time && formData.incident_start < toLocalInput(workItem.start_time);
  const endsBeforeFirstSignal = formData.incident_end && workItem.start_time && formData.incident_end < toLocalInput(workItem.start_time);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const set = (key) => (e) => { const { value } = e.target; setFormData(f => ({ ...f, [key]: value })); };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (new Date(formData.incident_end) < new Date(formData.incident_start)) {
      setError('Impact end must not be before impact start.');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      // datetime-local has no offset; toISOString() sends an unambiguous UTC instant.
      const created = await submitRCA(workItem.id, {
        ...formData,
        incident_start: new Date(formData.incident_start).toISOString(),
        incident_end: new Date(formData.incident_end).toISOString(),
      });
      onSuccess?.(created);
    } catch (err) {
      setError(errorMessage(err, 'Submission failed'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="panel rca">
      <div className="rca-head">
        <h2>Root cause analysis</h2>
        {rca && (
          <div className="rca-actions">
            <button type="button" className="pill" onClick={() => downloadMarkdown(workItem, rca)}><Icon name="download" size={12} />Export Markdown</button>
          </div>
        )}
      </div>

      {rca ? (
        <div className="rca-body">
          <ReadVal label="Impact start" value={fmtStamp(rca.incident_start)} />
          <ReadVal label="Impact end" value={fmtStamp(rca.incident_end)} />
          {/* after closing nobody can act on it, so only RESOLVED shows it */}
          {workItem.status !== 'CLOSED' && windowWarnings(rca, workItem.start_time).map(w => <p key={w} className="muted-sm rca-warn">{w}</p>)}
          <ReadVal label="Root Cause" value={rca.root_cause_category} />
          <ReadVal label="Fix applied" value={rca.fix_applied} />
          <ReadVal label="Prevention steps" value={rca.prevention_steps} />
        </div>
      ) : readOnly ? (
        <p className="muted">No RCA has been submitted yet.</p>
      ) : locked ? (
        <p className="muted">Start investigating to write the RCA.</p>
      ) : !open ? (
        <button type="button" className="btn btn-secondary" onClick={() => setExpanded(true)}>Write RCA</button>
      ) : (
        <form className="rca-body" onSubmit={handleSubmit}>
          <p className="muted">
            {workItem.status === 'INVESTIGATING' ? 'Needed to close the incident once it is resolved.' : 'Submit the RCA to close this incident.'}
          </p>
          <div className="rca-times">
            <Field label="Impact start">
              {id => <input id={id} type="datetime-local" required value={formData.incident_start} onChange={set('incident_start')} />}
            </Field>
            <Field label="Impact end">
              {id => <input id={id} type="datetime-local" required value={formData.incident_end} onChange={set('incident_end')} />}
            </Field>
          </div>
          <p className="muted-sm rca-hint">Pre-filled from the first and last signal. Adjust if needed.</p>
          {beforeFirstSignal && <p className="muted-sm rca-warn">Starts before the first signal ({fmtStamp(workItem.start_time)}).</p>}
          {endsBeforeFirstSignal && <p className="muted-sm rca-warn">Ends before the first signal ({fmtStamp(workItem.start_time)}).</p>}
          <Field label="Root cause category">
            {id => (
              <select id={id} required value={formData.root_cause_category} onChange={set('root_cause_category')}>
                <option value="" disabled>Choose a category</option>
                {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            )}
          </Field>
          <Field label="Fix applied">
            {id => <textarea id={id} required maxLength={MAX_TEXT} className="tall" placeholder="Describe what fix was applied…" value={formData.fix_applied} onChange={set('fix_applied')} />}
          </Field>
          <Field label="Prevention steps">
            {id => <textarea id={id} required maxLength={MAX_TEXT} className="tall" placeholder="How will this be prevented…" value={formData.prevention_steps} onChange={set('prevention_steps')} />}
          </Field>
          {error && <ErrorNote>{error}</ErrorNote>}
          <div className="rca-buttons">
            <button type="submit" className="btn btn-primary rca-submit" disabled={submitting}>
              {submitting ? <span className="spinner" /> : 'Submit RCA'}
            </button>
            {!defaultOpen && <button type="button" className="btn-link" onClick={() => setExpanded(false)}>Cancel</button>}
          </div>
        </form>
      )}
    </div>
  );
}
