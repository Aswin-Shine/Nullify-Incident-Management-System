import { useState } from 'react';
import { useAuth } from '../context/AuthContext';

// Accounts are invite-only: an admin creates them (API or `python -m app.cli create-user`).
export function LoginPage() {
  const [formData, setFormData] = useState({ username: '', password: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { login } = useAuth();

  const handleSubmit = async () => {
    setError(''); setLoading(true);
    try {
      await login(formData.username, formData.password);
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

        {/* Fields */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>Username</label>
            <input type="text" autoComplete="username" value={formData.username} onChange={e => setFormData({ ...formData, username: e.target.value })} onKeyDown={e => e.key === 'Enter' && handleSubmit()} placeholder="Enter username" />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>Password</label>
            <input type="password" autoComplete="current-password" value={formData.password} onChange={e => setFormData({ ...formData, password: e.target.value })} onKeyDown={e => e.key === 'Enter' && handleSubmit()} placeholder="••••••••" />
          </div>

          {error && (
            <div style={{ padding: '10px 14px', borderRadius: 8, background: 'var(--p0-bg)', color: 'var(--error)', fontSize: 12, animation: 'slideDown 0.2s', border: '1px solid rgba(248,113,113,0.2)' }}>
              {error}
            </div>
          )}

          <button onClick={handleSubmit} disabled={loading} className="btn btn-primary" style={{ height: 44, marginTop: 10, width: '100%', fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 600, fontSize: 14 }}>
            {loading ? <span className="spinner" /> : 'Sign In'}
          </button>
          <p style={{ fontSize: 12, color: 'var(--text-tertiary)', textAlign: 'center', marginTop: 4 }}>
            Accounts are created by an administrator.
          </p>
        </div>
      </div>
    </div>
  );
}
