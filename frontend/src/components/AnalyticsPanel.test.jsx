import { render, screen } from '@testing-library/react'
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
