import { useState } from 'react';
import { submitRCA, errorMessage } from '../api/client';
import { toLocalInput, rcaToMarkdown } from '../format';
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

const ReadVal = ({ label, value }) => (
  <div>
    <span className="read-label">{label}</span>
    <div className="read-value">{value || '-'}</div>
  </div>
);

// The impact window starts as the incident's own first and last signal times; the SRE adjusts it.
const initialForm = (wi) => ({
  incident_start: toLocalInput(wi.start_time),
  incident_end: toLocalInput(wi.last_signal_at ?? wi.start_time),
  root_cause_category: CATEGORIES[0], fix_applied: '', prevention_steps: '',
});

function downloadMarkdown(wi, rca) {
  const url = URL.createObjectURL(new Blob([rcaToMarkdown(wi, rca)], { type: 'text/markdown' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `rca-${wi.component.replace(/[^A-Za-z0-9_.-]/g, '_')}-${new Date().toISOString().slice(0, 10)}.md`;
  a.click();
  URL.revokeObjectURL(url);
}

// `rca` is the submitted RCA (or null); the parent owns fetching it. `readOnly` hides the form from viewers.
export function RCAForm({ workItem, rca, onSuccess, readOnly = false }) {
  const [formData, setFormData] = useState(() => initialForm(workItem));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const set = (key) => (e) => setFormData({ ...formData, [key]: e.target.value });

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
        <div className="rca-title">
          <span className="rca-mark"><Icon name="alert-triangle" /></span>
          <h3>Root Cause Analysis</h3>
        </div>
        {rca && (
          <div className="rca-actions">
            <button type="button" className="pill" onClick={() => downloadMarkdown(workItem, rca)}><Icon name="download" size={12} />Export Markdown</button>
            <span className="chip submitted" data-level="p3"><Icon name="check" size={12} />Submitted</span>
          </div>
        )}
      </div>

      {rca ? (
        <div className="rca-body">
          <ReadVal label="Impact Start" value={rca.incident_start} />
          <ReadVal label="Impact End" value={rca.incident_end} />
          <ReadVal label="Root Cause" value={rca.root_cause_category} />
          <ReadVal label="Fix Applied" value={rca.fix_applied} />
          <ReadVal label="Prevention Steps" value={rca.prevention_steps} />
        </div>
      ) : readOnly ? (
        <p className="muted">No RCA has been submitted yet.</p>
      ) : (
        <form className="rca-body" onSubmit={handleSubmit}>
          <div className="note-warn"><p>Incident cannot be closed without an approved RCA.</p></div>
          <div className="rca-times">
            <Field label="Impact Start">
              {id => <input id={id} type="datetime-local" required value={formData.incident_start} onChange={set('incident_start')} />}
            </Field>
            <Field label="Impact End">
              {id => <input id={id} type="datetime-local" required value={formData.incident_end} onChange={set('incident_end')} />}
            </Field>
          </div>
          <p className="muted-sm rca-hint">Pre-filled from the first and last signal. Adjust if needed.</p>
          <Field label="Root Cause Category">
            {id => (
              <select id={id} value={formData.root_cause_category} onChange={set('root_cause_category')}>
                {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            )}
          </Field>
          <Field label="Fix Applied">
            {id => <textarea id={id} required className="tall" placeholder="Describe what fix was applied…" value={formData.fix_applied} onChange={set('fix_applied')} />}
          </Field>
          <Field label="Prevention Steps">
            {id => <textarea id={id} required className="tall" placeholder="How will this be prevented…" value={formData.prevention_steps} onChange={set('prevention_steps')} />}
          </Field>
          {error && <ErrorNote>{error}</ErrorNote>}
          <button type="submit" className="btn btn-primary rca-submit" disabled={submitting}>
            {submitting ? <span className="spinner" /> : 'Submit RCA'}
          </button>
        </form>
      )}
    </div>
  );
}
