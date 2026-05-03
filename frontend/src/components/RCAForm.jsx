import { useState, useEffect } from 'react';
import { fetchRCA, submitRCA } from '../api/client';

const CATEGORIES = [
  'Infrastructure Failure', 'Code Defect', 'Configuration Error',
  'Dependency Outage', 'Capacity Exhaustion', 'Security Incident',
  'Human Error', 'Unknown',
];

export function RCAForm({ workItem, onSuccess }) {
  const [existing, setExisting] = useState(null);
  const [form, setForm] = useState({
    incident_start: workItem?.start_time?.slice(0, 16) || '',
    incident_end: workItem?.end_time?.slice(0, 16) || '',
    root_cause_category: CATEGORIES[0],
    fix_applied: '',
    prevention_steps: '',
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  useEffect(() => {
    fetchRCA(workItem.id).then(r => {
      if (r) { setExisting(r); }
    });
  }, [workItem.id]);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const handleSubmit = async () => {
    setError(''); setSuccess('');
    if (!form.fix_applied.trim() || !form.prevention_steps.trim()) {
      setError('Fix Applied and Prevention Steps are required.'); return;
    }
    setSubmitting(true);
    try {
      await submitRCA(workItem.id, {
        ...form,
        incident_start: new Date(form.incident_start).toISOString(),
        incident_end: new Date(form.incident_end).toISOString(),
      });
      setSuccess('RCA submitted. You may now close the incident.');
      onSuccess?.();
    } catch (e) {
      setError(e.response?.data?.detail || 'Submission failed');
    } finally { setSubmitting(false); }
  };

  const fieldLabel = (txt) => (
    <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-2)', letterSpacing: '0.08em', marginBottom: 4, marginTop: 12 }}>
      {txt}
    </div>
  );

  if (existing && !success) {
    return (
      <div style={{ padding: 16 }}>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--p3)', marginBottom: 12 }}>✓ RCA SUBMITTED</div>
        <div style={{ display: 'grid', gap: 8 }}>
          {[
            ['Category', existing.root_cause_category],
            ['Fix Applied', existing.fix_applied],
            ['Prevention', existing.prevention_steps],
            ['Submitted', new Date(existing.submitted_at).toLocaleString()],
          ].map(([k, v]) => (
            <div key={k}>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-2)' }}>{k}</div>
              <div style={{ fontSize: 13, color: 'var(--text-0)', marginTop: 2 }}>{v}</div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: 16 }}>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-2)', letterSpacing: '0.1em', marginBottom: 16 }}>
        ROOT CAUSE ANALYSIS
      </div>

      {fieldLabel('INCIDENT START')}
      <input type="datetime-local" value={form.incident_start}
        onChange={e => set('incident_start', e.target.value)} />

      {fieldLabel('INCIDENT END')}
      <input type="datetime-local" value={form.incident_end}
        onChange={e => set('incident_end', e.target.value)} />

      {fieldLabel('ROOT CAUSE CATEGORY')}
      <select value={form.root_cause_category} onChange={e => set('root_cause_category', e.target.value)}>
        {CATEGORIES.map(c => <option key={c}>{c}</option>)}
      </select>

      {fieldLabel('FIX APPLIED *')}
      <textarea placeholder="Describe the fix that was applied..."
        value={form.fix_applied} onChange={e => set('fix_applied', e.target.value)} />

      {fieldLabel('PREVENTION STEPS *')}
      <textarea placeholder="How will we prevent this in the future?"
        value={form.prevention_steps} onChange={e => set('prevention_steps', e.target.value)} />

      {error && (
        <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--p0)', marginTop: 10, padding: '8px 12px', background: 'var(--p0-bg)', borderRadius: 4, border: '1px solid var(--p0)33' }}>
          {error}
        </div>
      )}
      {success && (
        <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--p3)', marginTop: 10, padding: '8px 12px', background: 'var(--p3-bg)', borderRadius: 4 }}>
          {success}
        </div>
      )}

      <button onClick={handleSubmit} disabled={submitting}
        style={{
          marginTop: 14, width: '100%', padding: '10px', borderRadius: 4,
          background: submitting ? 'var(--bg-3)' : 'var(--accent-bg)',
          color: submitting ? 'var(--text-2)' : 'var(--accent-hover)',
          border: '1px solid var(--accent)',
          fontSize: 12, letterSpacing: '0.05em',
        }}>
        {submitting ? 'SUBMITTING...' : 'SUBMIT RCA'}
      </button>
    </div>
  );
}
