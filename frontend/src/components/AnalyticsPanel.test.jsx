import { render, screen, within } from '@testing-library/react'
import { AnalyticsPanel } from './AnalyticsPanel'
import * as api from '../api/client'

vi.mock('../api/client', async (orig) => ({
  ...(await orig()),
  fetchMTTR: vi.fn(), fetchSLA: vi.fn(), fetchTimeseries: vi.fn(), fetchWorkItems: vi.fn(),
}))

beforeEach(() => {
  vi.resetAllMocks()
  api.fetchMTTR.mockResolvedValue([{ component: 'RDBMS_PRIMARY', avg_mttr_seconds: 3600, incident_count: 2 }])
  api.fetchSLA.mockResolvedValue({ total: 5, breached: 1, breach_rate_pct: 20, open_by_priority: { P0: 2, P1: 1, P2: 0, P3: 0 } })
  api.fetchTimeseries.mockResolvedValue([])
  api.fetchWorkItems.mockResolvedValue([])
})

test('MTTR rows show the component name (F-03)', async () => {
  render(<AnalyticsPanel />)
  expect(await screen.findByText('RDBMS_PRIMARY')).toBeTruthy()
})

test('priority counts come from the SLA stats, not the work item list (F-18)', async () => {
  render(<AnalyticsPanel />)
  expect(await screen.findByText('P0: 2')).toBeTruthy()
  expect(screen.getByText('P1: 1')).toBeTruthy()
  expect(api.fetchWorkItems).not.toHaveBeenCalled()
})

const tile = (label) => within(screen.getByText(label).closest('.kpi'))

test('the KPI tiles show the open total, the weighted Avg MTTR and the backend breach rate', async () => {
  api.fetchMTTR.mockResolvedValue([
    { component: 'A', avg_mttr_seconds: 60, incident_count: 1 },
    { component: 'B', avg_mttr_seconds: 600, incident_count: 9 },
  ])
  api.fetchSLA.mockResolvedValue({ total: 5, breached: 1, breach_rate_pct: 33.3, open_by_priority: { P0: 2, P1: 1, P2: 0, P3: 0 } })
  render(<AnalyticsPanel />)
  await screen.findByText('Open incidents')
  expect(tile('Open incidents').getByText('3')).toBeTruthy()
  expect(tile('Open P0').getByText('2')).toBeTruthy()
  expect(tile('SLA breach rate').getByText('33%')).toBeTruthy()
  expect(tile('SLA breach rate').getByText('1 of 5 breached')).toBeTruthy()
  expect(tile('Avg MTTR').getByText('9m')).toBeTruthy()  // 546s weighted; the plain mean of the averages would be 6m
})

test('the signal volume chart is an image whose label carries the total', async () => {
  api.fetchTimeseries.mockResolvedValue([
    { bucket: '2026-10-04T10:02', signal_count: 4 },
    { bucket: '2026-10-04T10:00', signal_count: 6 },
  ])
  render(<AnalyticsPanel />)
  const chart = await screen.findByRole('img', { name: /Signal volume/ })
  expect(chart.getAttribute('aria-label')).toBe('Signal volume, last 3 minutes, 10 total')
})

test('with no signals the chart shows an empty state instead of an image', async () => {
  render(<AnalyticsPanel />)
  await screen.findByText('Open incidents')
  expect(screen.queryByRole('img', { name: /Signal volume/ })).toBeNull()
  expect(screen.getByText('No data')).toBeTruthy()
})
