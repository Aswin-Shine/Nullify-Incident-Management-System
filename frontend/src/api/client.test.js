// Each test loads a fresh copy of the client so the in-memory token and refresh state start clean.
async function load() {
  vi.resetModules()
  const axios = (await import('axios')).default
  const client = await import('./client')
  const seen = []
  client.api.defaults.adapter = async (config) => {
    seen.push(config.url)
    const reply = (status, data) => ({ data, status, statusText: '', headers: {}, config })
    if (config.url.endsWith('/login')) return reply(200, { access_token: 'old', user: {} })
    if (String(config.headers.Authorization) === 'Bearer old') {
      throw Object.assign(new Error('401'), { config, response: { status: 401 } })
    }
    return reply(200, { ok: true })
  }
  return { axios, client, seen }
}

async function signedIn() {
  const ctx = await load()
  await ctx.client.login({ username: 'u', password: 'p' })
  return ctx
}

test('a 401 refreshes once and retries the request', async () => {
  const { axios, client } = await signedIn()
  const post = vi.spyOn(axios, 'post').mockResolvedValue({ data: { access_token: 'new' } })
  const r = await client.api.get('/api/work-items')
  expect(r.data).toEqual({ ok: true })
  expect(post).toHaveBeenCalledTimes(1)
})

test('concurrent 401s share one refresh', async () => {
  const { axios, client } = await signedIn()
  let release
  const gate = new Promise(r => { release = r })
  const post = vi.spyOn(axios, 'post').mockImplementation(() => gate.then(() => ({ data: { access_token: 'new' } })))
  const calls = Promise.all([client.api.get('/api/a'), client.api.get('/api/b'), client.api.get('/api/c')])
  await new Promise(r => setTimeout(r, 10))
  release()
  await calls
  expect(post).toHaveBeenCalledTimes(1)
})

test('a failed refresh signals session expiry and rejects', async () => {
  const { axios, client } = await signedIn()
  vi.spyOn(axios, 'post').mockRejectedValue(new Error('refresh denied'))
  const expired = vi.fn()
  client.setOnSessionExpired(expired)
  await expect(client.api.get('/api/work-items')).rejects.toBeTruthy()
  expect(expired).toHaveBeenCalledTimes(1)
  expect(client.getAccessToken()).toBeNull()
})

test('errorMessage turns string, array and missing details into one string', async () => {
  const { client } = await load()
  expect(client.errorMessage({ response: { data: { detail: 'Lost race' } } })).toBe('Lost race')
  expect(client.errorMessage({ response: { data: { detail: [{ msg: 'a' }, { msg: 'b' }] } } })).toBe('a; b')
  expect(client.errorMessage(new Error('plain bug'), 'Failed')).toBe('Failed')
})

const axiosErr = (response) => Object.assign(new Error('x'), { isAxiosError: true, response })
const res = (status, data = {}, headers = {}) => ({ status, data, headers })

test('errorMessage says what happened: no response, 403, 5xx, and the generic 500 body', async () => {
  const { client } = await load()
  expect(client.errorMessage(axiosErr(undefined), 'Failed')).toBe("Can't reach the server. Check your connection and try again.")
  expect(client.errorMessage(axiosErr(res(403)), 'Failed')).toBe("You don't have permission to do that.")
  const server = 'The server hit an error. Try again; if it keeps failing, check the backend logs.'
  expect(client.errorMessage(axiosErr(res(500, { detail: 'Internal Server Error' })), 'Failed')).toBe(server)
  expect(client.errorMessage(axiosErr(res(500, '<html>oops</html>')), 'Failed')).toBe(server)
  expect(client.errorMessage(axiosErr(res(500, { detail: 'Database is locked' })), 'Failed')).toBe('Database is locked')
  expect(client.errorMessage(axiosErr(res(403, { detail: 'Admins only' })), 'Failed')).toBe('Admins only')
  expect(client.errorMessage(axiosErr(res(404)), 'Incident not found')).toBe('Incident not found')
  expect(client.errorMessage(axiosErr(res(409)), 'Failed')).toBe('Failed')
})

test('errorMessage on 429 reads Retry-After, and falls back to "in a moment"', async () => {
  const { client } = await load()
  expect(client.errorMessage(axiosErr(res(429, { detail: 'Rate limit exceeded' }, { 'retry-after': '30' })))).toBe('Too many requests. Try again in 30 seconds.')
  expect(client.errorMessage(axiosErr(res(429, {}, { 'retry-after': '1' })))).toBe('Too many requests. Try again in 1 second.')
  expect(client.errorMessage(axiosErr(res(429)))).toBe('Too many requests. Try again in a moment.')
  expect(client.errorMessage(axiosErr(res(429, {}, { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' })))).toBe('Too many requests. Try again in a moment.')
})

test('errorMessage keeps the 422 list as one line and an empty list as the fallback', async () => {
  const { client } = await load()
  expect(client.errorMessage(axiosErr(res(422, { detail: [{ msg: 'a' }, { msg: 'b' }] })))).toBe('a; b')
  expect(client.errorMessage(axiosErr(res(422, { detail: [] })), 'Failed')).toBe('Failed')
})

test('changePassword stores the returned access token for the next request', async () => {
  const { client } = await load()
  const headers = []
  client.api.defaults.adapter = async (config) => {
    headers.push(String(config.headers.Authorization))
    const reply = (data) => ({ data, status: 200, statusText: '', headers: {}, config })
    return config.url.endsWith('/password') ? reply({ access_token: 'fresh', user: {} }) : reply({ ok: true })
  }
  const data = await client.changePassword('old-password-123', 'a-brand-new-passphrase')
  expect(data.access_token).toBe('fresh')
  expect(client.getAccessToken()).toBe('fresh')
  await client.api.get('/api/auth/me')
  expect(headers.at(-1)).toBe('Bearer fresh')
})


test('fetchWorkItems sends only the filters that are set, and fetchHistory hits the history route', async () => {
  const { client } = await load()
  const get = vi.spyOn(client.api, 'get').mockResolvedValue({ data: {} })
  await client.fetchWorkItems({ status: 'OPEN', limit: 100, q: 'rdbms', priority: undefined, assignee: 'me' })
  expect(get).toHaveBeenLastCalledWith('/api/work-items', { params: { status: 'OPEN', limit: 100, q: 'rdbms', assignee: 'me' } })
  await client.fetchWorkItems({})
  expect(get).toHaveBeenLastCalledWith('/api/work-items', { params: {} })
  await client.fetchHistory('wi-1')
  expect(get).toHaveBeenLastCalledWith('/api/work-items/wi-1/history')
})

test('fetchTimeseries asks for the last 60 minutes', async () => {
  const { client } = await load()
  let params
  client.api.defaults.adapter = async (config) => { params = config.params; return { data: [], status: 200, statusText: '', headers: {}, config } }
  await client.fetchTimeseries()
  expect(params).toEqual({ limit: 60 })
})

test('fetchRCA gives null for a 404 and rethrows anything else (F-38)', async () => {
  const { client } = await load()
  const failWith = (status) => {
    client.api.defaults.adapter = async (config) => { throw Object.assign(new Error(String(status)), { config, response: { status } }) }
  }
  failWith(404)
  expect(await client.fetchRCA('wi-1')).toBeNull()
  failWith(500)
  await expect(client.fetchRCA('wi-1')).rejects.toBeTruthy()
})

test('errorMessage drops the pydantic "Value error, " prefix from each 422 message', async () => {
  const { client } = await load()
  expect(client.errorMessage(axiosErr(res(422, { detail: [{ msg: 'Value error, Comment must be at most 4000 characters' }] })))).toBe('Comment must be at most 4000 characters')
  expect(client.errorMessage(axiosErr(res(422, { detail: [{ msg: 'Value error, a' }, { msg: 'Field required' }] })))).toBe('a; Field required')
})

test.each([502, 503, 504])('errorMessage reads a %i gateway error as the API being unreachable', async (status) => {
  const { client } = await load()
  expect(client.errorMessage(axiosErr(res(status, '<html>gateway</html>')), 'Failed')).toBe('The API is unreachable right now. Try again in a moment.')
})

test('errorMessage keeps the server-error text for 500 and other 5xx', async () => {
  const { client } = await load()
  const server = 'The server hit an error. Try again; if it keeps failing, check the backend logs.'
  expect(client.errorMessage(axiosErr(res(500)), 'Failed')).toBe(server)
  expect(client.errorMessage(axiosErr(res(501)), 'Failed')).toBe(server)
})
