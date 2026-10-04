import { render, screen } from '@testing-library/react'
import { ErrorBoundary } from './ErrorBoundary'

function Boom() { throw new Error('kaboom') }

beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}) })
afterEach(() => { vi.restoreAllMocks() })

test('a throwing child renders the fallback, not a blank pane (F-04)', () => {
  render(<ErrorBoundary><Boom /></ErrorBoundary>)
  expect(screen.getByRole('alert').textContent).toMatch(/something went wrong/i)
})

test('the fallback tells the user to reload, without pointing at another item', () => {
  render(<ErrorBoundary><Boom /></ErrorBoundary>)
  expect(screen.getByRole('alert').textContent).toMatch(/Reload the page to try again\./)
  expect(screen.getByRole('alert').textContent).not.toMatch(/another item/i)
})

test('a new resetKey clears the error', () => {
  const { rerender } = render(<ErrorBoundary resetKey="a"><Boom /></ErrorBoundary>)
  rerender(<ErrorBoundary resetKey="b"><p>fine</p></ErrorBoundary>)
  expect(screen.getByText('fine')).toBeTruthy()
})
