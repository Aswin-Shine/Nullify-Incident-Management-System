import { useState } from 'react';
import { submitRCA, errorMessage } from '../api/client';
import { ErrorNote } from './ErrorNote';
import { Field } from './Field';

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

const EMPTY = { incident_start: '', incident_end: '', root_cause_category: CATEGORIES[0], fix_applied: '', prevention_steps: '' };

// `rca` is the submitted RCA (or null); the parent owns fetching it. `readOnly` hides the form from viewers.
export function RCAForm({ workItem, rca, onSuccess, readOnly = false }) {
  const [formData, setFormData] = useState(EMPTY);
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
    <div className="glass rca">
      <div className="rca-head">
        <div className="rca-title">
          <span className="rca-mark">◈</span>
          <h3>Root Cause Analysis</h3>
        </div>
        {rca && <span className="chip submitted" data-level="p3">✓ Submitted</span>}
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
