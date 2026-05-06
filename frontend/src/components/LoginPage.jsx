import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { register as apiRegister } from '../api/client';

export function LoginPage() {
  const [isRegister, setIsRegister] = useState(false);
  const [formData, setFormData] = useState({ username: '', password: '', email: '', role: 'sre' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { login } = useAuth();

  const handleSubmit = async () => {
    setError(''); setLoading(true);
    try {
      if (isRegister) {
        await apiRegister(formData);
        setIsRegister(false);
      } else {
        await login(formData.username, formData.password);
      }
    } catch (err) {
      setError(err.response?.data?.detail || 'Authentication failed');
    } finally { setLoading(false); }
  };

  return (
    <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-base)' }}>
      <div className="glass" style={{ width: '100%', maxWidth: 400, padding: 40, borderRadius: 24, boxShadow: '0 32px 80px rgba(0,0,0,0.4)', animation: 'slideDown 0.4s ease-out' }}>

        {/* Logo */}
        <div style={{ textAlign: 'center', marginBottom: 36 }}>
          <div style={{ width: 48, height: 48, borderRadius: 14, background: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24, margin: '0 auto 16px', boxShadow: '0 0 24px var(--accent-glow)', animation: 'glowPulse 3s ease-in-out infinite' }}>∅</div>
          <h1 style={{ fontSize: 32, fontWeight: 800, color: 'var(--text-primary)' }}>Nullify</h1>
          <p style={{ fontSize: 13, color: 'var(--text-tertiary)', marginTop: 4 }}>Incidents, terminated.</p>
        </div>

        {/* Mode toggle */}
        <div style={{ display: 'flex', background: 'var(--bg-raised)', borderRadius: 12, padding: 4, marginBottom: 28 }}>
          {[['login', 'Sign In'], ['register', 'Register']].map(([m, label]) => (
            <div key={m} onClick={() => { setIsRegister(m === 'register'); setError(''); }}
              style={{ flex: 1, textAlign: 'center', padding: 8, borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600, transition: 'all 0.2s', background: (isRegister ? m === 'register' : m === 'login') ? 'var(--accent)' : 'transparent', color: (isRegister ? m === 'register' : m === 'login') ? 'white' : 'var(--text-secondary)' }}>
              {label}
            </div>
          ))}
        </div>

        {/* Fields */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>Username</label>
            <input type="text" value={formData.username} onChange={e => setFormData({ ...formData, username: e.target.value })} onKeyDown={e => e.key === 'Enter' && handleSubmit()} placeholder="Enter username" />
          </div>
          {isRegister && (
            <div>
              <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>Email</label>
              <input type="email" value={formData.email} onChange={e => setFormData({ ...formData, email: e.target.value })} placeholder="you@company.com" />
            </div>
          )}
          <div>
            <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>Password</label>
            <input type="password" value={formData.password} onChange={e => setFormData({ ...formData, password: e.target.value })} onKeyDown={e => e.key === 'Enter' && handleSubmit()} placeholder="••••••••" />
          </div>
          {isRegister && (
            <div>
              <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>Role</label>
              <select value={formData.role} onChange={e => setFormData({ ...formData, role: e.target.value })}>
                <option value="viewer">Viewer</option>
                <option value="sre">SRE</option>
                <option value="admin">Admin</option>
              </select>
            </div>
          )}

          {error && (
            <div style={{ padding: '10px 14px', borderRadius: 8, background: 'var(--p0-bg)', color: 'var(--error)', fontSize: 12, animation: 'slideDown 0.2s', border: '1px solid rgba(248,113,113,0.2)' }}>
              {error}
            </div>
          )}

          <button onClick={handleSubmit} disabled={loading} className="btn btn-primary" style={{ height: 44, marginTop: 10, width: '100%', fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 600, fontSize: 14 }}>
            {loading ? <span className="spinner" /> : (isRegister ? 'Create Account' : 'Sign In')}
          </button>
        </div>
      </div>
    </div>
  );
}
