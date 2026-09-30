import axios from 'axios';

// Same-origin by default: nginx (Docker) or the Vite dev proxy forwards /api, /ws and /health.
const BASE = import.meta.env.VITE_API_URL ?? '';

export const api = axios.create({ baseURL: BASE });

// The access token lives only in memory. The refresh token is an httpOnly cookie that the browser
// sends to /api/auth/* on its own; nothing auth-related is ever written to localStorage.
let accessToken = null;
export const getAccessToken = () => accessToken;

let onSessionExpired = () => {};
export const setOnSessionExpired = (fn) => { onSessionExpired = fn; };

const CSRF = { 'X-Requested-With': 'nullify' };
const NO_AUTO_REFRESH = /\/api\/auth\/(login|refresh|logout)$/;

api.interceptors.request.use(cfg => {
  if (accessToken) cfg.headers.Authorization = `Bearer ${accessToken}`;
  return cfg;
});

// One refresh in flight at a time: concurrent 401s all wait for the same request.
let refreshing = null;
export function refreshSession() {
  refreshing ??= axios.post(`${BASE}/api/auth/refresh`, null, { headers: CSRF })
    .then(r => { accessToken = r.data.access_token; return r.data; })
    .finally(() => { refreshing = null; });
  return refreshing;
}

// An expired access token gets one silent refresh + retry; if that fails the session is over.
api.interceptors.response.use(undefined, async (error) => {
  const { config, response } = error;
  if (response?.status !== 401 || config._retried || NO_AUTO_REFRESH.test(config.url)) throw error;
  config._retried = true;
  try {
    await refreshSession();
  } catch {
    accessToken = null;
    onSessionExpired();
    throw error;
  }
  return api(config);
});

// One readable string from a FastAPI error: a string detail, a 422 list of {msg}, or no response at all.
export function errorMessage(e, fallback = 'Request failed') {
  const detail = e?.response?.data?.detail;
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) return detail.map(d => d.msg ?? String(d)).join('; ') || fallback;
  return fallback;
}

// Auth
export const login = (d) => api.post('/api/auth/login', d).then(r => { accessToken = r.data.access_token; return r.data; });
export const logout = () => api.post('/api/auth/logout', null, { headers: CSRF }).finally(() => { accessToken = null; });
export const getMe = () => api.get('/api/auth/me').then(r => r.data);
export const rotateApiKey = () => api.post('/api/auth/api-key').then(r => r.data);
export const listUsers = () => api.get('/api/auth/users').then(r => r.data);

// Work items
export const fetchWorkItems = (status) =>
  api.get('/api/work-items', { params: status ? { status } : {} }).then(r => r.data);
export const fetchWorkItem = (id) => api.get(`/api/work-items/${id}`).then(r => r.data);
export const fetchSignals = (id) => api.get(`/api/work-items/${id}/signals`).then(r => r.data);
export const fetchRCA = (id) => api.get(`/api/work-items/${id}/rca`).then(r => r.data).catch(() => null);
export const updateStatus = (id, new_status) =>
  api.patch(`/api/work-items/${id}/status`, { new_status }).then(r => r.data);
export const assignWorkItem = (id, assignee_id) =>
  api.patch(`/api/work-items/${id}/assign`, { assignee_id }).then(r => r.data);
export const submitRCA = (id, data) => api.post(`/api/work-items/${id}/rca`, data).then(r => r.data);

// Comments
export const fetchComments = (id) => api.get(`/api/work-items/${id}/comments`).then(r => r.data);
export const addComment = (id, body) =>
  api.post(`/api/work-items/${id}/comments`, { body }).then(r => r.data);

// Signals
export const ingestSignal = (data) => api.post('/api/signals', data).then(r => r.data);

// Health + analytics
// /health answers 503 with a JSON body when degraded; show that body instead of throwing.
export const fetchHealth = () => api.get('/health', { validateStatus: s => s < 600 }).then(r => r.data);
export const fetchTimeseries = () => api.get('/api/timeseries', { params: { limit: 20 } }).then(r => r.data);
export const fetchMTTR = () => api.get('/api/work-items/analytics/mttr').then(r => r.data);
export const fetchSLA = () => api.get('/api/work-items/analytics/sla').then(r => r.data);