import { useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { register } from '../api/client'

export function LoginPage() {
  const { login } = useAuth()
  const [mode, setMode] = useState('login') // login | register
  const [form, setForm] = useState({ username: '', email: '', password: '', role: 'sre' })
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const submit = async () => {
    setError(''); setLoading(true)
    try {
      if (mode === 'register') {
        await register(form)
        setMode('login')
        setError('')
        return
      }
      await login(form.username, form.password)
    } catch (e) {
      setError(e.response?.data?.detail || 'Failed')
    } finally { setLoading(false) }
  }

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'var(--bg-0)',
    }}>
      <div style={{
        width: 380, background: 'var(--bg-1)', border: '1px solid var(--border)',
        borderRadius: 8, padding: 32,
      }}>
        {/* Logo */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 32 }}>
          <div style={{
            width: 36, height: 36, background: 'var(--accent)', borderRadius: 8,
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18,
          }}>⚡</div>
          <div>
            <div style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 15 }}>IMS</div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--text-2)', letterSpacing: '0.1em' }}>
              INCIDENT MANAGEMENT
            </div>
          </div>
        </div>

        <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-2)', letterSpacing: '0.1em', marginBottom: 20 }}>
          {mode === 'login' ? 'SIGN IN' : 'CREATE ACCOUNT'}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <input placeholder="Username" value={form.username}
            onChange={e => set('username', e.target.value)}
            onKeyDown={e => e.key === 'Enter' && submit()} />

          {mode === 'register' && (
            <>
              <input placeholder="Email" type="email" value={form.email}
                onChange={e => set('email', e.target.value)} />
              <select value={form.role} onChange={e => set('role', e.target.value)}>
                <option value="viewer">Viewer</option>
                <option value="sre">SRE</option>
                <option value="admin">Admin</option>
              </select>
            </>
          )}

          <input placeholder="Password" type="password" value={form.password}
            onChange={e => set('password', e.target.value)}
            onKeyDown={e => e.key === 'Enter' && submit()} />
        </div>

        {error && (
          <div style={{
            marginTop: 10, fontFamily: 'var(--mono)', fontSize: 11,
            color: 'var(--p0)', padding: '8px 12px',
            background: 'var(--p0-bg)', borderRadius: 4,
          }}>{error}</div>
        )}

        <button onClick={submit} disabled={loading}
          style={{
            marginTop: 16, width: '100%', padding: 10, borderRadius: 4,
            background: loading ? 'var(--bg-3)' : 'var(--accent-bg)',
            color: loading ? 'var(--text-2)' : 'var(--accent-hover)',
            border: '1px solid var(--accent)', fontSize: 12,
          }}>
          {loading ? 'PLEASE WAIT...' : mode === 'login' ? 'SIGN IN' : 'REGISTER'}
        </button>

        <div style={{ marginTop: 16, textAlign: 'center' }}>
          <button onClick={() => { setMode(m => m === 'login' ? 'register' : 'login'); setError('') }}
            style={{
              background: 'transparent', color: 'var(--text-2)',
              fontSize: 11, fontFamily: 'var(--mono)',
            }}>
            {mode === 'login' ? 'Create account →' : '← Back to login'}
          </button>
        </div>
      </div>
    </div>
  )
}
