import { toLocalInput, rcaToMarkdown, fmtMTTR } from './format'

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
