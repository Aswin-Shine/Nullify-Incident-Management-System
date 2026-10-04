import { render, screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AnalyticsPanel } from './AnalyticsPanel'
import * as api from '../api/client'
import { networkError } from '../test/utils'

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
  expect(tile('SLA breach rate').getByText('1 of 5, all incidents')).toBeTruthy()
  expect(tile('Avg MTTR').getByText('9m')).toBeTruthy()  // 546s weighted; the plain mean of the averages would be 6m
})

test('the signal volume chart is an image whose label carries the total', async () => {
  const minuteAgo = (n) => new Date(Date.now() - n * 60000).toISOString().slice(0, 16)
  api.fetchTimeseries.mockResolvedValue([
    { bucket: minuteAgo(1), signal_count: 4 },
    { bucket: minuteAgo(3), signal_count: 6 },
  ])
  render(<AnalyticsPanel />)
  const chart = await screen.findByRole('img', { name: /Signal volume/ })
  expect(chart.getAttribute('aria-label')).toBe('Signal volume, last 60 minutes, 10 total')
  expect(screen.getByText(/peak 6/)).toBeTruthy()  // the peak sits in the aside, next to the total
})

test('rows older than the window show a quiet empty state, not the error box', async () => {
  const minutesAgo = (n) => new Date(Date.now() - n * 60000).toISOString().slice(0, 16)
  api.fetchTimeseries.mockResolvedValue([
    { bucket: minutesAgo(90), signal_count: 5 },
    { bucket: minutesAgo(120), signal_count: 2 },
  ])
  render(<AnalyticsPanel />)
  expect(await screen.findByText('No signals in the last hour')).toBeTruthy()
  expect(screen.queryByText(/went wrong/i)).toBeNull()
  expect(screen.queryByRole('img', { name: /Signal volume/ })).toBeNull()
  expect(screen.getByText('0 total')).toBeTruthy()
  expect(tile('Open incidents').getByText('3')).toBeTruthy()
})

test('one row inside the window still draws the chart and its peak', async () => {
  const minutesAgo = (n) => new Date(Date.now() - n * 60000).toISOString().slice(0, 16)
  api.fetchTimeseries.mockResolvedValue([
    { bucket: minutesAgo(2), signal_count: 3 },
    { bucket: minutesAgo(90), signal_count: 5 },
  ])
  render(<AnalyticsPanel />)
  const chart = await screen.findByRole('img', { name: /Signal volume/ })
  expect(chart.getAttribute('aria-label')).toBe('Signal volume, last 60 minutes, 3 total')
  expect(screen.getByText(/peak 3/)).toBeTruthy()
})

test('with no signals the chart shows an empty state instead of an image', async () => {
  render(<AnalyticsPanel />)
  await screen.findByText('Open incidents')
  expect(screen.queryByRole('img', { name: /Signal volume/ })).toBeNull()
  expect(screen.getByText('No data')).toBeTruthy()
})

test('a new refreshTick refetches all three queries (F-40)', async () => {
  const { rerender } = render(<AnalyticsPanel refreshTick={0} />)
  await screen.findByText('Open incidents')
  rerender(<AnalyticsPanel refreshTick={1} />)
  await waitFor(() => {
    for (const f of [api.fetchMTTR, api.fetchSLA, api.fetchTimeseries]) expect(f).toHaveBeenCalledTimes(2)
  })
})

test('long component names carry the full name as a tooltip and the cards are level-2 headings (F-42)', async () => {
  render(<AnalyticsPanel />)
  expect((await screen.findByText('RDBMS_PRIMARY')).title).toBe('RDBMS_PRIMARY')
  expect(screen.getByRole('heading', { level: 2, name: 'Signal volume' })).toBeTruthy()
})

test('the KPI tiles say what window and sample they cover', async () => {
  api.fetchMTTR.mockResolvedValue([
    { component: 'A', avg_mttr_seconds: 60, incident_count: 1 },
    { component: 'B', avg_mttr_seconds: 600, incident_count: 9 },
  ])
  api.fetchSLA.mockResolvedValue({ total: 12, breached: 3, breach_rate_pct: 25, open_by_priority: { P0: 1, P1: 0, P2: 0, P3: 0 } })
  render(<AnalyticsPanel />)
  await screen.findByText('Open incidents')
  expect(tile('Open incidents').getByText('right now')).toBeTruthy()
  expect(tile('Open P0').getByText('right now')).toBeTruthy()
  expect(tile('SLA breach rate').getByText('3 of 12, all incidents')).toBeTruthy()
  expect(tile('Avg MTTR').getByText('across 10 incidents')).toBeTruthy()
})

test('Avg MTTR with no closed incidents shows a dash and no sample size', async () => {
  api.fetchMTTR.mockResolvedValue([])
  render(<AnalyticsPanel />)
  await screen.findByText('Open incidents')
  expect(tile('Avg MTTR').queryByText(/across/)).toBeNull()
})

describe('fourth critique: Analytics as a tool', () => {
  const kpi = (label) => screen.getByText(label).closest('.kpi')
  const sla = (open_by_priority) => ({ total: 5, breached: 1, breach_rate_pct: 20, open_by_priority })

  test('the open tiles are buttons that say where they go and what they count', async () => {
    const onShowIncidents = vi.fn()
    render(<AnalyticsPanel onShowIncidents={onShowIncidents} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Show 3 open incidents' }))
    expect(onShowIncidents).toHaveBeenLastCalledWith({ status: 'ACTIVE' })
    await userEvent.click(screen.getByRole('button', { name: 'Show 2 open P0 incidents' }))
    expect(onShowIncidents).toHaveBeenLastCalledWith({ status: 'ACTIVE', priority: 'P0' })
  })

  test('one open incident reads in the singular', async () => {
    api.fetchSLA.mockResolvedValue(sla({ P0: 0, P1: 1, P2: 0, P3: 0 }))
    render(<AnalyticsPanel onShowIncidents={() => {}} />)
    expect(await screen.findByRole('button', { name: 'Show 1 open incident' })).toBeTruthy()
  })

  test('the breach-rate and MTTR tiles stay static', async () => {
    render(<AnalyticsPanel onShowIncidents={() => {}} />)
    await screen.findByText('Open incidents')
    expect(kpi('SLA breach rate').tagName).not.toBe('BUTTON')
    expect(kpi('Avg MTTR').tagName).not.toBe('BUTTON')
    expect(screen.getAllByRole('button')).toHaveLength(2)
  })

  test('a tile that counts nothing is not a button: there is nothing to go and see', async () => {
    api.fetchSLA.mockResolvedValue(sla({ P0: 0, P1: 0, P2: 0, P3: 0 }))
    render(<AnalyticsPanel onShowIncidents={() => {}} />)
    await screen.findByText('Open incidents')
    expect(screen.queryByRole('button')).toBeNull()
    expect(within(kpi('Open incidents')).getByText('0')).toBeTruthy()
  })

  test('with no open incidents at all the folded bar is empty but the tile still renders', async () => {
    api.fetchSLA.mockResolvedValue({ total: 0, breached: 0, breach_rate_pct: 0, open_by_priority: {} })
    const { container } = render(<AnalyticsPanel />)
    await screen.findByText('Open incidents')
    expect(container.querySelectorAll('.stack-seg')).toHaveLength(0)
    expect(within(kpi('Open incidents')).getByText('P0: 0')).toBeTruthy()
  })

  test('the open-by-priority bar lives inside the Open incidents tile, and the separate panel is gone', async () => {
    const { container } = render(<AnalyticsPanel />)
    await screen.findByText('Open incidents')
    expect(screen.queryByRole('heading', { name: 'Open by priority' })).toBeNull()
    const first = container.querySelector('.kpi-strip').firstElementChild
    expect(first).toBe(kpi('Open incidents'))
    expect(first.querySelector('.stack')).not.toBeNull()
    expect(within(first).getByText('P0: 2')).toBeTruthy()
    expect(container.querySelectorAll('.stack')).toHaveLength(1)
  })

  test('Signal volume and MTTR by component are both full width', async () => {
    const { container } = render(<AnalyticsPanel />)
    await screen.findByText('Open incidents')
    for (const name of ['Signal volume', 'MTTR by component']) {
      expect(screen.getByRole('heading', { name }).closest('section').classList.contains('span-12')).toBe(true)
    }
    expect(container.querySelector('.span-8, .span-4')).toBeNull()
  })

  describe('a low sample is said out loud', () => {
    test('with fewer than 5 incidents behind Avg MTTR the value is muted and the sub-line says so', async () => {
      api.fetchMTTR.mockResolvedValue([{ component: 'A', avg_mttr_seconds: 60, incident_count: 2 }])
      render(<AnalyticsPanel />)
      await screen.findByText('Open incidents')
      expect(within(kpi('Avg MTTR')).getByText('only 2 incidents, too few to trust')).toBeTruthy()
      expect(kpi('Avg MTTR').dataset.lowSample).toBe('true')
    })

    test('one incident reads in the singular', async () => {
      api.fetchMTTR.mockResolvedValue([{ component: 'A', avg_mttr_seconds: 60, incident_count: 1 }])
      render(<AnalyticsPanel />)
      await screen.findByText('Open incidents')
      expect(within(kpi('Avg MTTR')).getByText('only 1 incident, too few to trust')).toBeTruthy()
    })

    test('exactly 5 is enough: the plain sample size, not muted', async () => {
      api.fetchMTTR.mockResolvedValue([{ component: 'A', avg_mttr_seconds: 60, incident_count: 5 }])
      render(<AnalyticsPanel />)
      await screen.findByText('Open incidents')
      expect(within(kpi('Avg MTTR')).getByText('across 5 incidents')).toBeTruthy()
      expect(kpi('Avg MTTR').dataset.lowSample).toBeUndefined()
    })

    test('no incidents at all is the dash, with no caveat (there is no sample to distrust)', async () => {
      api.fetchMTTR.mockResolvedValue([])
      render(<AnalyticsPanel />)
      await screen.findByText('Open incidents')
      expect(within(kpi('Avg MTTR')).queryByText(/too few/)).toBeNull()
      expect(kpi('Avg MTTR').dataset.lowSample).toBeUndefined()
    })

    test('MTTR rows with fewer than 3 incidents get a faint bar', async () => {
      api.fetchMTTR.mockResolvedValue([
        { component: 'THIN', avg_mttr_seconds: 600, incident_count: 2 },
        { component: 'SOLID', avg_mttr_seconds: 300, incident_count: 3 },
      ])
      const { container } = render(<AnalyticsPanel />)
      await screen.findByText('THIN')
      const fill = (name) => screen.getByText(name).closest('.mttr-row').querySelector('.bar-fill')
      expect(fill('THIN').dataset.thin).toBe('true')
      expect(fill('SOLID').dataset.thin).toBeUndefined()
      expect(container.querySelectorAll('.bar-fill[data-thin]')).toHaveLength(1)
    })
  })
})

describe('fifth critique: clickable tiles say so', () => {
  test('the action tiles carry a chevron, the static tiles do not', async () => {
    render(<AnalyticsPanel onShowIncidents={() => {}} />)
    await screen.findByText('Open incidents')
    const actions = [...document.querySelectorAll('.kpi-action')]
    expect(actions).toHaveLength(2)
    for (const tile of actions) expect(tile.querySelector('.kpi-chevron svg.icon')).not.toBeNull()
    const statics = [...document.querySelectorAll('.kpi:not(.kpi-action)')]
    expect(statics.length).toBeGreaterThan(0)
    for (const tile of statics) expect(tile.querySelector('svg')).toBeNull()
  })
})

describe('harden', () => {
  test('a failed load says why, and one Try again fetches all three queries again', async () => {
    api.fetchSLA.mockRejectedValueOnce(networkError())
    render(<AnalyticsPanel />)
    expect(await screen.findByText(/Can't reach the server/)).toBeTruthy()
    expect(screen.getAllByRole('button', { name: 'Try again' })).toHaveLength(1)
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(screen.queryByText(/Can't reach the server/)).toBeNull())
    expect(api.fetchSLA).toHaveBeenCalledTimes(2)
    expect(api.fetchMTTR).toHaveBeenCalledTimes(2)
    expect(api.fetchTimeseries).toHaveBeenCalledTimes(2)
  })

  test('a big open count uses thousands separators and zero open reads as plain zeros', async () => {
    api.fetchSLA.mockResolvedValue({ total: 5000, breached: 1200, breach_rate_pct: 24, open_by_priority: { P0: 1500, P1: 0, P2: 0, P3: 0 } })
    const { unmount } = render(<AnalyticsPanel onShowIncidents={() => {}} />)
    const open = await screen.findByRole('button', { name: 'Show 1,500 open incidents' })
    expect(within(open).getByText('1,500')).toBeTruthy()
    expect(screen.getByText('1,200 of 5,000, all incidents')).toBeTruthy()
    unmount()
    api.fetchSLA.mockResolvedValue({ total: 0, breached: 0, breach_rate_pct: 0, open_by_priority: {} })
    render(<AnalyticsPanel onShowIncidents={() => {}} />)
    await screen.findByText('Open incidents')
    expect(screen.queryByRole('button', { name: /Show 0 open/ })).toBeNull()
    expect(tile('Open incidents').getByText('P0: 0')).toBeTruthy()
  })
})
