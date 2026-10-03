import { sortIncidents } from './sort'

const wi = (id, over = {}) => ({
  id, component: id.toUpperCase(), priority: 'P1', status: 'OPEN', created_at: '2026-01-01T00:00:00Z',
  sla_deadline: null, assignee_username: null, ...over,
})
const ids = (list) => list.map(i => i.id)

test('priority: P0 first ascending, P3 first descending, ties keep the server order in both directions', () => {
  const items = [wi('a', { priority: 'P2' }), wi('b', { priority: 'P0' }), wi('c', { priority: 'P2' }), wi('d', { priority: 'P3' }), wi('e', { priority: 'P0' })]
  expect(ids(sortIncidents(items, 'priority', 'asc'))).toEqual(['b', 'e', 'a', 'c', 'd'])
  expect(ids(sortIncidents(items, 'priority', 'desc'))).toEqual(['d', 'a', 'c', 'b', 'e'])
})

test('component: A-Z ascending, Z-A descending', () => {
  const items = [wi('x', { component: 'cache' }), wi('y', { component: 'API' }), wi('z', { component: 'DB' })]
  expect(ids(sortIncidents(items, 'component', 'asc'))).toEqual(['y', 'x', 'z'])
  expect(ids(sortIncidents(items, 'component', 'desc'))).toEqual(['z', 'x', 'y'])
})

test('status: OPEN, INVESTIGATING, RESOLVED, CLOSED ascending', () => {
  const items = [wi('a', { status: 'CLOSED' }), wi('b', { status: 'OPEN' }), wi('c', { status: 'RESOLVED' }), wi('d', { status: 'INVESTIGATING' })]
  expect(ids(sortIncidents(items, 'status', 'asc'))).toEqual(['b', 'd', 'c', 'a'])
  expect(ids(sortIncidents(items, 'status', 'desc'))).toEqual(['a', 'c', 'd', 'b'])
})

test('sla: soonest deadline first; no deadline and finished incidents go last in both directions', () => {
  const items = [
    wi('late', { sla_deadline: '2026-01-02T00:00:00Z' }),
    wi('none'),
    wi('soon', { sla_deadline: '2026-01-01T01:00:00Z' }),
    wi('done', { status: 'RESOLVED', sla_deadline: '2026-01-01T00:30:00Z' }),
    wi('shut', { status: 'CLOSED', sla_deadline: '2026-01-01T00:10:00Z' }),
  ]
  expect(ids(sortIncidents(items, 'sla', 'asc'))).toEqual(['soon', 'late', 'none', 'done', 'shut'])
  expect(ids(sortIncidents(items, 'sla', 'desc'))).toEqual(['late', 'soon', 'none', 'done', 'shut'])
})

test('assignee: by username, Unassigned last in both directions', () => {
  const items = [wi('a', { assignee_username: 'carol' }), wi('b'), wi('c', { assignee_username: 'alice' }), wi('d', { assignee_username: 'bob' })]
  expect(ids(sortIncidents(items, 'assignee', 'asc'))).toEqual(['c', 'd', 'a', 'b'])
  expect(ids(sortIncidents(items, 'assignee', 'desc'))).toEqual(['a', 'd', 'c', 'b'])
})

test('age: ascending is newest first, descending is oldest first', () => {
  const items = [wi('old', { created_at: '2026-01-01T00:00:00Z' }), wi('new', { created_at: '2026-03-01T00:00:00Z' }), wi('mid', { created_at: '2026-02-01T00:00:00Z' })]
  expect(ids(sortIncidents(items, 'age', 'asc'))).toEqual(['new', 'mid', 'old'])
  expect(ids(sortIncidents(items, 'age', 'desc'))).toEqual(['old', 'mid', 'new'])
})

test('sorting returns a copy and never mutates the input', () => {
  const items = [wi('b', { component: 'B' }), wi('a', { component: 'A' })]
  const out = sortIncidents(items, 'component', 'asc')
  expect(out).not.toBe(items)
  expect(ids(items)).toEqual(['b', 'a'])
})

test('equal keys keep their input order (stable)', () => {
  const items = [wi('1', { component: 'SAME' }), wi('2', { component: 'SAME' }), wi('3', { component: 'SAME' })]
  expect(ids(sortIncidents(items, 'component', 'asc'))).toEqual(['1', '2', '3'])
  expect(ids(sortIncidents(items, 'component', 'desc'))).toEqual(['1', '2', '3'])
})
