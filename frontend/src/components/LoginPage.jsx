import { useState } from 'react';
import { useAuth } from '../context/auth';
import { errorMessage } from '../api/client';
import { ErrorNote } from './ErrorNote';
import { Field } from './Field';
import { Icon } from './Icon';

// Accounts are invite-only: an admin creates them (API or `python -m app.cli create-user`).
export function LoginPage() {
  const [formData, setFormData] = useState({ username: '', password: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { login } = useAuth();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(''); setLoading(true);
    try {
      await login(formData.username, formData.password);
    } catch (err) {
      setError(errorMessage(err, 'Authentication failed'));
    } finally { setLoading(false); }
  };

  return (
    <main className="login">
      <div className="panel login-card">
        <div className="login-head">
          <div className="login-logo"><Icon name="null" size={24} /></div>
          <h1>Nullify</h1>
          <p>Incidents, terminated.</p>
        </div>

        <form className="login-form" onSubmit={handleSubmit}>
          <Field label="Username">
            {id => <input id={id} name="username" type="text" autoComplete="username" value={formData.username} onChange={e => setFormData({ ...formData, username: e.target.value })} placeholder="Enter username" />}
          </Field>
          <Field label="Password">
            {id => <input id={id} name="password" type="password" autoComplete="current-password" value={formData.password} onChange={e => setFormData({ ...formData, password: e.target.value })} placeholder="••••••••" />}
          </Field>

          {error && <ErrorNote>{error}</ErrorNote>}

          <button type="submit" disabled={loading} className="btn btn-primary login-submit">
            {loading ? <span className="spinner" /> : 'Sign in'}
          </button>
          <p className="login-note">Accounts are created by an administrator.</p>
        </form>
      </div>
    </main>
  );
}
