import { formatDistanceToNowStrict } from 'date-fns';

// Small display helpers shared by several components.

// "1 incident" / "2 incidents": the word for a count, from the English plural rules (0 is plural).
const PLURALS = new Intl.PluralRules('en');
export const plural = (n, one, many = `${one}s`) => (PLURALS.select(n) === 'one' ? one : many);

// "2m", "5h", "3d": the compact age used in dense lists.
const AGE_UNIT = { second: 's', minute: 'm', hour: 'h', day: 'd', month: 'mo', year: 'y' };
export function shortAge(iso) {
  return formatDistanceToNowStrict(new Date(iso)).replace(/^(\d+) (\w+?)s?$/, (_, n, unit) => n + (AGE_UNIT[unit] ?? unit));
}
export function fmtMTTR(s) {
  if (!s) return null;
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 48 * 3600) return `${(s / 3600).toFixed(1)}h`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;  // 73.5h reads as 3d 1h
}

// How long ago an SLA deadline passed, as days/hours/minutes (the two largest units; under an hour it is minutes only).
const MIN_MS = 60000, HOUR_MS = 3600000, DAY_MS = 86400000;
function lateBy(deadline, now) {
  const ms = Math.max(0, now - new Date(deadline));
  return { ms, d: Math.floor(ms / DAY_MS), h: Math.floor((ms % DAY_MS) / HOUR_MS), m: Math.floor((ms % HOUR_MS) / MIN_MS) };
}
// "+5d 3h", "+2h 10m", "+4m"
export function breachAge(deadline, now = Date.now()) {
  const { d, h, m } = lateBy(deadline, now);
  return d ? `+${d}d ${h}h` : h ? `+${h}h ${m}m` : `+${m}m`;
}
// "5 days 3 hours", for screen readers
export function breachAgeWords(deadline, now = Date.now()) {
  const { d, h, m } = lateBy(deadline, now);
  const unit = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  return d ? `${unit(d, 'day')} ${unit(h, 'hour')}` : h ? `${unit(h, 'hour')} ${unit(m, 'minute')}` : unit(m, 'minute');
}
// A breach is red (the "act now" colour) only while it is under an hour old, for every priority; an older one
// is marked quietly, P0 included: the P0 chip already carries the row's severity.
export const breachLevel = (deadline, now = Date.now()) =>
  lateBy(deadline, now).ms < HOUR_MS ? 'p0' : 'muted';

// A resolved incident owes its RCA within RCA_DUE_HOURS. null when nothing is owed: not RESOLVED, an RCA exists
// (end_time is set only by the RCA submission), or no resolved time. Otherwise the time left, or the time since it
// fell due, as "1d" (short), "1d 23h" (long) and "1 day 23 hours" (words).
export const RCA_DUE_HOURS = 48;
export function rcaDue({ status, end_time: rcaAt, resolved_at: resolvedAt }, now = Date.now()) {
  if (status !== 'RESOLVED' || rcaAt || !resolvedAt) return null;
  const due = new Date(resolvedAt).getTime() + RCA_DUE_HOURS * HOUR_MS;
  const overdue = now >= due;
  const [from, to] = overdue ? [due, now] : [now, due];  // lateBy(from, to) is to - from
  const long = breachAge(from, to).slice(1);  // drops the "+"
  return { overdue, short: long.split(' ')[0], long, words: breachAgeWords(from, to) };
}

// Signal-volume rows ({bucket:'YYYY-MM-DDTHH:mm', signal_count}, any order) -> the last `max` minutes up to the
// current minute, oldest first, with minutes that had no signals as 0 (no rows at all gives []). Buckets are
// UTC minutes, so the maths is done in UTC.
const MINUTE = 60000;
export function fillBuckets(rows, max = 60, now = Date.now()) {
  if (!rows?.length) return [];
  const at = new Map(rows.map(r => [Date.parse(`${r.bucket}:00Z`), r.signal_count]));
  const end = Math.floor(now / MINUTE) * MINUTE;
  const out = [];
  for (let t = end - (max - 1) * MINUTE; t <= end; t += MINUTE) {
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

// ISO instant -> a short local stamp like "Sep 29, 05:23" ('-' if unusable).
export function fmtStamp(iso) {
  const d = new Date(iso ?? NaN);
  return isNaN(d) ? '-' : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// How fast a burst of `count` signals came in between two ISO instants: "≈ 4/min" or "≈ 3/h", whichever unit
// gives a number of 1 or more. null for a single signal, a span under a minute, or a trickle under 1 per hour.
export function signalRate(count, firstIso, lastIso) {
  const ms = new Date(lastIso) - new Date(firstIso);
  if (count < 2 || !(ms >= MINUTE)) return null;
  const perMin = count / (ms / MINUTE);
  if (perMin >= 1) return `≈ ${Math.round(perMin)}/min`;
  const perHour = Math.round(perMin * 60);
  return perHour >= 1 ? `≈ ${perHour}/h` : null;
}

// The toast after Start Investigating: it claims an unowned incident for you, so say so when the response shows it.
export const startedMessage = (before, updated, userId) =>
  !before?.assignee_id && updated.assignee_id === userId ? 'Investigating · assigned to you' : `Moved to ${updated.status}`;

// Copy the incident's deep link and toast the outcome (no clipboard on plain http, or the browser refused).
export async function copyIncidentLink(id, toast) {
  try {
    await navigator.clipboard.writeText(`${window.location.origin}/?incident=${id}`);
    toast('Link copied');
  } catch {
    toast('Could not copy the link', { kind: 'error' });
  }
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
