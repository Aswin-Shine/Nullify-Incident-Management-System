import * as format from './format'
import { toLocalInput, rcaToMarkdown, fmtMTTR, shortAge, fillBuckets, weightedMTTR, fmtStamp, breachAge, breachAgeWords, breachLevel, plural, rcaDue, RCA_DUE_HOURS } from './format'

test('fmtMTTR keeps seconds, minutes and hours, and switches to days from 48 hours', () => {
  expect(fmtMTTR(30)).toBe('30s')
  expect(fmtMTTR(5400)).toBe('1.5h')
  expect(fmtMTTR(47.9 * 3600)).toBe('47.9h')
  expect(fmtMTTR(48 * 3600)).toBe('2d 0h')
  expect(fmtMTTR(73.5 * 3600)).toBe('3d 1h')
  expect(fmtMTTR(null)).toBeNull()
})

test('toLocalInput gives the local YYYY-MM-DDTHH:mm and round-trips to the same minute', () => {
  const iso = '2026-03-04T10:15:00Z'
  const local = toLocalInput(iso)
  expect(local).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
  expect(new Date(local).toISOString()).toBe('2026-03-04T10:15:00.000Z')
})

test('toLocalInput uses the browser local time, not UTC', () => {
  const d = new Date('2026-03-04T10:15:00Z')
  const pad = n => String(n).padStart(2, '0')
  expect(toLocalInput(d.toISOString())).toBe(
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`)
})

test('toLocalInput returns an empty string for null, undefined and garbage', () => {
  expect(toLocalInput(null)).toBe('')
  expect(toLocalInput(undefined)).toBe('')
  expect(toLocalInput('not a date')).toBe('')
})

const wi = { id: 'wi-1', component: 'RDBMS_PRIMARY', priority: 'P0', status: 'CLOSED', title: 'DB down',
  start_time: '2026-03-04T10:00:00Z', mttr_seconds: 5400 }
const rca = { incident_start: '2026-03-04T10:00:00Z', incident_end: '2026-03-04T11:30:00Z',
  root_cause_category: 'Code Defect', fix_applied: 'Rolled back\nthen restarted', prevention_steps: 'Add canary',
  submitted_at: '2026-03-04T12:00:00Z' }

test('rcaToMarkdown has the heading, summary and every RCA section', () => {
  const md = rcaToMarkdown(wi, rca)
  expect(md).toContain('# Postmortem: RDBMS_PRIMARY')
  expect(md).toContain('P0')
  expect(md).toContain(fmtMTTR(5400))
  expect(md).toContain('2026-03-04T10:00:00Z')
  expect(md).toContain('2026-03-04T11:30:00Z')
  expect(md).toContain('Code Defect')
  expect(md).toContain('Add canary')
  expect(md).toContain('2026-03-04T12:00:00Z')
})

test('rcaToMarkdown keeps multi-line fix text intact', () => {
  expect(rcaToMarkdown(wi, rca)).toContain('Rolled back\nthen restarted')
})

test('avatars are neutral: there is no per-name colour helper any more', () => {
  expect(format.avatarColor).toBeUndefined()
})

test('shortAge gives the compact 30s / 2m / 5h / 3d form', () => {
  vi.useFakeTimers()
  try {
    vi.setSystemTime(new Date('2026-03-04T12:00:00Z'))
    const ago = (ms) => new Date(Date.now() - ms).toISOString()
    expect(shortAge(ago(30_000))).toBe('30s')
    expect(shortAge(ago(2 * 60_000))).toBe('2m')
    expect(shortAge(ago(5 * 3600_000))).toBe('5h')
    expect(shortAge(ago(3 * 86400_000))).toBe('3d')
  } finally { vi.useRealTimers() }
})

describe('fillBuckets', () => {
  const row = (bucket, signal_count) => ({ bucket, signal_count })
  const now = Date.UTC(2026, 9, 4, 10, 3, 30)  // 10:03 UTC, with seconds to prove the minute is truncated

  test('spans the last 60 minutes ending at the current minute, oldest first, with empty minutes as 0 (F-41)', () => {
    const out = fillBuckets([row('2026-10-04T10:03', 7), row('2026-10-04T10:00', 5)], 60, now)  // newest first, as the API sends them
    expect(out).toHaveLength(60)
    expect(out.at(-1)).toEqual(row('2026-10-04T10:03', 7))
    expect(out.at(-4)).toEqual(row('2026-10-04T10:00', 5))
    expect(out.at(-3)).toEqual(row('2026-10-04T10:01', 0))
    expect(out[0].bucket).toBe('2026-10-04T09:04')
  })

  test('when the newest signal is old the chart is a flat zero line ending now, not a window ending then (F-41)', () => {
    const out = fillBuckets([row('2026-10-04T07:00', 9)], 60, now)
    expect(out).toHaveLength(60)
    expect(out.at(-1).bucket).toBe('2026-10-04T10:03')
    expect(out.every(b => b.signal_count === 0)).toBe(true)
  })

  test('a signal five minutes ago lands at the right index (F-41)', () => {
    const out = fillBuckets([row('2026-10-04T09:58', 3)], 60, now)
    expect(out[out.length - 1 - 5]).toEqual(row('2026-10-04T09:58', 3))
  })

  test('fills across an hour and a day boundary', () => {
    const out = fillBuckets([row('2026-10-05T00:01', 1), row('2026-10-04T23:59', 2)], 60, Date.UTC(2026, 9, 5, 0, 1))
    expect(out.slice(-3).map(r => r.bucket)).toEqual(['2026-10-04T23:59', '2026-10-05T00:00', '2026-10-05T00:01'])
    expect(out.slice(-3).map(r => r.signal_count)).toEqual([2, 0, 1])
  })

  test('keeps only the newest 60 minutes', () => {
    const at = Date.UTC(2026, 9, 4, 12, 0)
    const rows = Array.from({ length: 100 }, (_, i) => row(new Date(at - i * 60000).toISOString().slice(0, 16), i + 1))
    const out = fillBuckets(rows, 60, at)
    expect(out).toHaveLength(60)
    expect(out.at(-1)).toEqual(row('2026-10-04T12:00', 1))
    expect(out[0].bucket).toBe('2026-10-04T11:01')
  })

  test('empty input gives an empty list', () => {
    expect(fillBuckets([], 60, now)).toEqual([])
    expect(fillBuckets(undefined, 60, now)).toEqual([])
  })
})

describe('weightedMTTR', () => {
  test('weights each component average by its incident count', () => {
    expect(weightedMTTR([{ avg_mttr_seconds: 60, incident_count: 1 }, { avg_mttr_seconds: 600, incident_count: 9 }])).toBe(546)
  })

  test('is null for empty input or no counted incidents', () => {
    expect(weightedMTTR([])).toBeNull()
    expect(weightedMTTR([{ avg_mttr_seconds: null, incident_count: 0 }])).toBeNull()
  })
})

test('fmtStamp is a short local date and time that carries the minutes', () => {
  const d = new Date(2026, 8, 29, 5, 23)  // local time, so the check holds in any timezone
  const out = fmtStamp(d.toISOString())
  expect(out).toContain('05:23')
  expect(out).toMatch(/Sep/)
})

test('fmtStamp gives a dash for a missing or unusable value', () => {
  expect(fmtStamp(null)).toBe('-')
  expect(fmtStamp(undefined)).toBe('-')
  expect(fmtStamp('not a date')).toBe('-')
})

describe('breach age', () => {
  const now = Date.UTC(2026, 9, 4, 12, 0, 0)
  const late = (ms) => new Date(now - ms).toISOString()
  const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000

  test('breachAge is how long ago the deadline passed, in the two largest units', () => {
    expect(breachAge(late(3 * HOUR + 10 * MIN), now)).toBe('+3h 10m')
    expect(breachAge(late(5 * DAY + 3 * HOUR), now)).toBe('+5d 3h')
    expect(breachAge(late(4 * MIN), now)).toBe('+4m')
    expect(breachAge(late(2 * HOUR), now)).toBe('+2h 0m')
  })

  test('breachAgeWords is the same age spelled out for screen readers', () => {
    expect(breachAgeWords(late(5 * DAY + 3 * HOUR), now)).toBe('5 days 3 hours')
    expect(breachAgeWords(late(DAY + HOUR), now)).toBe('1 day 1 hour')
    expect(breachAgeWords(late(2 * HOUR + 10 * MIN), now)).toBe('2 hours 10 minutes')
    expect(breachAgeWords(late(MIN), now)).toBe('1 minute')
  })

  test('a breach stays red only while it is under an hour old', () => {
    expect(breachLevel(late(10 * MIN), now)).toBe('p0')
    expect(breachLevel(late(59 * MIN), now)).toBe('p0')
    expect(breachLevel(late(HOUR), now)).toBe('muted')
    expect(breachLevel(late(2 * HOUR), now)).toBe('muted')
  })

  test('an old breach is muted for a P0 too: the P0 chip is the only severity carrier on the row', () => {
    // the level takes no priority at all: a P0 breached 2 hours ago and a P2 breached 2 hours ago read the same
    expect(breachLevel(late(2 * HOUR), now)).toBe('muted')
    expect(breachLevel(late(5 * DAY), now)).toBe('muted')
  })
})

describe('signalRate', () => {
  const at = (ms) => new Date(Date.UTC(2026, 0, 1) + ms).toISOString()
  const MIN = 60_000, HOUR = 3_600_000

  test('10 signals over 5 minutes is about 2 per minute', () => {
    expect(format.signalRate(10, at(0), at(5 * MIN))).toBe('≈ 2/min')
  })

  test('3 signals over 2 hours is about 2 per hour', () => {
    expect(format.signalRate(3, at(0), at(2 * HOUR))).toBe('≈ 2/h')
  })

  test('one signal, or a span under a minute, has no rate', () => {
    expect(format.signalRate(1, at(0), at(0))).toBeNull()
    expect(format.signalRate(5, at(0), at(30_000))).toBeNull()
  })

  test('a rate that rounds to under 1 per hour is not shown', () => {
    expect(format.signalRate(2, at(0), at(10 * HOUR))).toBeNull()
  })
})

test('plural picks the singular only for exactly 1 (0 and 2 take the plural)', () => {
  expect(plural(0, 'incident')).toBe('incidents')
  expect(plural(1, 'incident')).toBe('incident')
  expect(plural(2, 'incident')).toBe('incidents')
  expect(plural(1, 'entry', 'entries')).toBe('entry')
  expect(plural(3, 'entry', 'entries')).toBe('entries')
})

describe('rcaDue', () => {
  const now = Date.UTC(2026, 9, 4, 12, 0, 0)
  const HOUR = 3_600_000
  const resolved = (agoMs, over = {}) => ({ status: 'RESOLVED', end_time: null, resolved_at: new Date(now - agoMs).toISOString(), ...over })

  test('nothing is owed unless the incident is RESOLVED without an RCA and has a resolved time', () => {
    expect(rcaDue(resolved(HOUR, { status: 'INVESTIGATING' }), now)).toBeNull()
    expect(rcaDue(resolved(HOUR, { status: 'CLOSED' }), now)).toBeNull()
    expect(rcaDue(resolved(HOUR, { end_time: new Date(now).toISOString() }), now)).toBeNull()
    expect(rcaDue(resolved(HOUR, { resolved_at: null }), now)).toBeNull()
  })

  test('within the window it is due, with the time left', () => {
    expect(RCA_DUE_HOURS).toBe(48)
    expect(rcaDue(resolved(HOUR), now)).toEqual({ overdue: false, short: '1d', long: '1d 23h', words: '1 day 23 hours' })
    expect(rcaDue(resolved(47 * HOUR + 30 * 60_000), now)).toMatchObject({ overdue: false, short: '30m' })
  })

  test('from 48 hours after resolving it is overdue, with the time since', () => {
    expect(rcaDue(resolved(48 * HOUR), now)).toMatchObject({ overdue: true, short: '0m' })
    expect(rcaDue(resolved(51 * HOUR + 5 * 60_000), now)).toEqual({ overdue: true, short: '3h', long: '3h 5m', words: '3 hours 5 minutes' })
  })
})
