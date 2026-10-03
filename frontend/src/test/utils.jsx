import { render, act } from '@testing-library/react'
import * as api from '../api/client'
import { AuthProvider } from '../context/AuthContext'
import { ToastProvider } from '../components/Toaster'

// The calling test file must mock '../api/client' with a refreshSession mock (AuthProvider restores the
// session through it). Renders under a real AuthProvider signed in with the given role (plus any extra user fields).
export async function renderAs(role, ui, userExtra = {}) {
  api.refreshSession.mockResolvedValue({ user: { id: 'u1', username: 'me', role, ...userExtra } })
  const wrap = (node) => <AuthProvider><ToastProvider>{node}</ToastProvider></AuthProvider>
  const result = render(wrap(ui))
  await act(async () => { await new Promise(r => setTimeout(r, 0)) })
  return { ...result, rerender: (next) => result.rerender(wrap(next)) }
}

export const deferred = () => {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

export const workItem = (over = {}) => ({
  id: 'wi-1', component: 'RDBMS_PRIMARY', priority: 'P0', status: 'OPEN', title: 'DB down',
  created_at: new Date(Date.now() - 3600_000).toISOString(), sla_deadline: null,
  assignee_id: null, assignee_username: null, mttr_seconds: null, ...over,
})

export const httpError = (status, detail) => ({ response: { status, data: { detail } } })
