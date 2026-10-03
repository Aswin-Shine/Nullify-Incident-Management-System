import { render, screen, act, fireEvent } from '@testing-library/react'
import { ToastProvider } from './Toaster'
import { useToast } from '../context/toast'

function Fire({ message = 'Saved', options }) {
  const toast = useToast()
  return <button type="button" onClick={() => toast(message, options)}>fire {message}</button>
}

const mount = (ui) => render(<ToastProvider>{ui}</ToastProvider>)
const fire = (name) => fireEvent.click(screen.getByRole('button', { name: `fire ${name}` }))

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

test('shows a toast in a polite live region and dismisses it after 4 seconds', () => {
  const { container } = mount(<Fire />)
  expect(container.querySelector('[aria-live="polite"]')).not.toBeNull()
  fire('Saved')
  expect(screen.getByText('Saved')).toBeTruthy()
  act(() => { vi.advanceTimersByTime(3900) })
  expect(screen.queryByText('Saved')).not.toBeNull()
  act(() => { vi.advanceTimersByTime(200) })
  expect(screen.queryByText('Saved')).toBeNull()
})

test('the close button dismisses a toast', () => {
  mount(<Fire />)
  fire('Saved')
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
  expect(screen.queryByText('Saved')).toBeNull()
})

test('shows at most 3 toasts, dropping the oldest', () => {
  mount(<><Fire message="one" /><Fire message="two" /><Fire message="three" /><Fire message="four" /></>)
  for (const m of ['one', 'two', 'three', 'four']) fire(m)
  expect(screen.queryByText('one')).toBeNull()
  for (const m of ['two', 'three', 'four']) expect(screen.getByText(m)).toBeTruthy()
})

test('an alert toast uses role=alert, stays 10 seconds, and its action runs and dismisses it', () => {
  const onClick = vi.fn()
  mount(<Fire message="New P0: DB" options={{ kind: 'alert', action: { label: 'Open', onClick } }} />)
  fire('New P0: DB')
  expect(screen.getByRole('alert').textContent).toContain('New P0: DB')
  act(() => { vi.advanceTimersByTime(9000) })
  expect(screen.queryByText('New P0: DB')).not.toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Open' }))
  expect(onClick).toHaveBeenCalledTimes(1)
  expect(screen.queryByText('New P0: DB')).toBeNull()
})

test('an alert toast disappears after 10 seconds on its own', () => {
  mount(<Fire message="Boom" options={{ kind: 'alert' }} />)
  fire('Boom')
  act(() => { vi.advanceTimersByTime(10100) })
  expect(screen.queryByText('Boom')).toBeNull()
})
