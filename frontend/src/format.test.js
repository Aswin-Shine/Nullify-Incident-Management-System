import * as format from './format'
import { toLocalInput, rcaToMarkdown, fmtMTTR, shortAge, fillBuckets, weightedMTTR } from './format'

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

  test('returns the rows oldest first and fills missing minutes with 0', () => {
    const out = fillBuckets([row('2026-10-04T10:03', 7), row('2026-10-04T10:00', 5)])  // newest first, as the API sends them
    expect(out).toEqual([
      row('2026-10-04T10:00', 5), row('2026-10-04T10:01', 0), row('2026-10-04T10:02', 0), row('2026-10-04T10:03', 7),
    ])
  })

  test('fills across an hour and a day boundary', () => {
    const out = fillBuckets([row('2026-10-05T00:01', 1), row('2026-10-04T23:59', 2)])
    expect(out.map(r => r.bucket)).toEqual(['2026-10-04T23:59', '2026-10-05T00:00', '2026-10-05T00:01'])
  })

  test('keeps only the newest 60 minutes', () => {
    const rows = Array.from({ length: 100 }, (_, i) => row(new Date(Date.UTC(2026, 9, 4, 12, 0) - i * 60000).toISOString().slice(0, 16), i + 1))
    const out = fillBuckets(rows)
    expect(out).toHaveLength(60)
    expect(out.at(-1)).toEqual(row('2026-10-04T12:00', 1))
    expect(out[0].bucket).toBe('2026-10-04T11:01')
  })

  test('empty input gives an empty list', () => {
    expect(fillBuckets([])).toEqual([])
    expect(fillBuckets(undefined)).toEqual([])
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
