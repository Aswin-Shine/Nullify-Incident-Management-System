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
  expect(client.errorMessage(new Error('Network Error'), 'Failed')).toBe('Failed')
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
