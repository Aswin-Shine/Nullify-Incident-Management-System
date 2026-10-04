import { render } from '@testing-library/react'
import { StatusBadge, PriorityBadge } from './Badges'

test.each([['OPEN', 'Open'], ['INVESTIGATING', 'Investigating'], ['CLOSED', 'Closed']])('%s carries its status and a drawn shape, no colour class', (status, word) => {
  const { container } = render(<StatusBadge status={status} />)
  const badge = container.querySelector('.status')
  expect(badge.dataset.status).toBe(status)
  expect(badge.textContent).toBe(word)
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

test.each([['OPEN', 'Open'], ['INVESTIGATING', 'Investigating'], ['RESOLVED', 'Resolved'], ['CLOSED', 'Closed']])('%s keeps its word, in sentence case, in its own span, so a narrow row can show only the shape', (status, word) => {
  const { container } = render(<StatusBadge status={status} />)
  expect(container.querySelector('.status .status-word').textContent).toBe(word)
})
