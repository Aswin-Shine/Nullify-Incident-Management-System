import { render } from '@testing-library/react'
import { StatusBadge, PriorityBadge } from './Badges'

test.each(['OPEN', 'INVESTIGATING', 'CLOSED'])('%s carries its status and a drawn shape, no colour class', (status) => {
  const { container } = render(<StatusBadge status={status} />)
  const badge = container.querySelector('.status')
  expect(badge.dataset.status).toBe(status)
  expect(badge.textContent).toBe(status)
  expect(badge.querySelector('.status-shape')).not.toBeNull()
})

test('RESOLVED carries a check icon instead of a dot shape', () => {
  const { container } = render(<StatusBadge status="RESOLVED" />)
  const badge = container.querySelector('.status')
  expect(badge.dataset.status).toBe('RESOLVED')
  expect(badge.querySelector('svg.icon')).not.toBeNull()
  expect(badge.querySelector('.status-shape')).toBeNull()
})

test('a muted priority chip is marked so it can render neutral', () => {
  const { container } = render(<PriorityBadge priority="P0" muted />)
  expect(container.querySelector('.chip').dataset.muted).toBe('true')
  const loud = render(<PriorityBadge priority="P0" />).container.querySelector('.chip')
  expect(loud.dataset.muted).toBeUndefined()
})

test.each(['OPEN', 'INVESTIGATING', 'RESOLVED', 'CLOSED'])('%s keeps its word in its own span, so a narrow row can show only the shape', (status) => {
  const { container } = render(<StatusBadge status={status} />)
  expect(container.querySelector('.status .status-word').textContent).toBe(status)
})
