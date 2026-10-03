// Small display helpers shared by several components.
export function avatarColor(name = '') {
  const hash = [...name].reduce((acc, c) => c.charCodeAt(0) + ((acc << 5) - acc), 0);
  return `hsl(${Math.abs(hash) % 360}, 65%, 55%)`;
}

export function fmtMTTR(s) {
  if (!s) return null;
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}

// ISO instant -> the local "YYYY-MM-DDTHH:mm" a datetime-local input expects ('' if unusable).
export function toLocalInput(iso) {
  const d = new Date(iso ?? NaN);
  if (isNaN(d)) return '';
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Markdown postmortem for a downloaded file (never rendered by the app, so user text is written as is).
export function rcaToMarkdown(wi, rca) {
  return `# Postmortem: ${wi.component}

| | |
|---|---|
| Incident | ${wi.id} |
| Priority | ${wi.priority} |
| Status | ${wi.status} |
| Title | ${wi.title ?? '-'} |
| First signal | ${wi.start_time ?? '-'} |
| MTTR | ${fmtMTTR(wi.mttr_seconds) ?? '-'} |
| RCA submitted | ${rca.submitted_at ?? '-'} |

## Impact window

${rca.incident_start} to ${rca.incident_end}

## Root cause category

${rca.root_cause_category}

## Fix applied

${rca.fix_applied}

## Prevention

${rca.prevention_steps}
`;
}
