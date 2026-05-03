import axios from 'axios';

const BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000';

export const api = axios.create({ baseURL: BASE });

// Inject token on every request
api.interceptors.request.use(cfg => {
  const token = localStorage.getItem('ims_token');
  if (token) cfg.headers.Authorization = `Bearer ${token}`;
  return cfg;
});

// Auth
export const login = (d) => api.post('/api/auth/login', d).then(r => r.data);
export const register = (d) => api.post('/api/auth/register', d).then(r => r.data);
export const refreshToken = (refresh_token) => api.post('/api/auth/refresh', { refresh_token }).then(r => r.data);
export const getMe = () => api.get('/api/auth/me').then(r => r.data);
export const rotateApiKey = () => api.post('/api/auth/rotate-api-key').then(r => r.data);
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
export const fetchHealth = () => api.get('/health').then(r => r.data);
export const fetchTimeseries = () => api.get('/api/timeseries', { params: { limit: 20 } }).then(r => r.data);
export const fetchMTTR = () => api.get('/api/work-items/analytics/mttr').then(r => r.data);
export const fetchSLA = () => api.get('/api/work-items/analytics/sla').then(r => r.data);