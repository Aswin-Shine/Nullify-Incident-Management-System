import { formatDistanceToNowStrict } from 'date-fns';

// Small display helpers shared by several components.

// "2m", "5h", "3d": the compact age used in dense lists.
const AGE_UNIT = { second: 's', minute: 'm', hour: 'h', day: 'd', month: 'mo', year: 'y' };
export function shortAge(iso) {
  return formatDistanceToNowStrict(new Date(iso)).replace(/^(\d+) (\w+?)s?$/, (_, n, unit) => n + (AGE_UNIT[unit] ?? unit));
}
export function fmtMTTR(s) {
  if (!s) return null;
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}

// Signal-volume rows ({bucket:'YYYY-MM-DDTHH:mm', signal_count}, any order) -> the newest 60 minutes, oldest first,
// with minutes that had no signals filled in as 0. Buckets are UTC minutes, so the maths is done in UTC.
const MINUTE = 60000;
export function fillBuckets(rows, max = 60) {
  if (!rows?.length) return [];
  const at = new Map(rows.map(r => [Date.parse(`${r.bucket}:00Z`), r.signal_count]));
  const times = [...at.keys()];
  const end = Math.max(...times);
  const start = Math.max(Math.min(...times), end - (max - 1) * MINUTE);
  const out = [];
  for (let t = start; t <= end; t += MINUTE) {
    out.push({ bucket: new Date(t).toISOString().slice(0, 16), signal_count: at.get(t) ?? 0 });
  }
  return out;
}

// Mean time to resolve across components, weighted by how many incidents each average covers (null when none).
export function weightedMTTR(rows) {
  const counted = (rows ?? []).filter(r => r.avg_mttr_seconds != null && r.incident_count > 0);
  const n = counted.reduce((a, r) => a + r.incident_count, 0);
  return n ? counted.reduce((a, r) => a + r.avg_mttr_seconds * r.incident_count, 0) / n : null;
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
