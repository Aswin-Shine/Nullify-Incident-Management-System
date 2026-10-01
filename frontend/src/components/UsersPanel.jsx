import { useState } from 'react';
import { listAccounts, createUser, updateUser, errorMessage } from '../api/client';
import { useAuth } from '../context/auth';
import { useQuery } from '../hooks/useQuery';
import { ErrorNote } from './ErrorNote';
import { Field } from './Field';

const ROLES = ['admin', 'sre', 'viewer'];
const NEW_USER = { username: '', email: '', password: '', role: 'viewer' };

function ResetPassword({ username, onSave }) {
  const [open, setOpen] = useState(false);
  const [pw, setPw] = useState('');
  if (!open) return <button type="button" className="btn-link" onClick={() => setOpen(true)}>Reset password</button>;
  return (
    <span className="reset-row">
      <input name="reset_password" type="password" autoComplete="new-password" aria-label={`New password for ${username}`}
        value={pw} onChange={e => setPw(e.target.value)} />
      <button type="button" className="btn-link" disabled={pw.length < 12}
        onClick={async () => { if (await onSave(pw)) { setPw(''); setOpen(false); } }}>Save</button>
      <button type="button" className="btn-link" onClick={() => { setPw(''); setOpen(false); }}>Cancel</button>
    </span>
  );
}

export function UsersPanel() {
  const { user: me } = useAuth();
  const accounts = useQuery('accounts', listAccounts);
  const [error, setError] = useState('');
  const [form, setForm] = useState(NEW_USER);
  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }));

  // Runs a mutation, then reloads the list; resolves true on success so callers can reset their input.
  const run = async (call) => {
    setError('');
    try {
      await call();
      accounts.reload();
      return true;
    } catch (e) {
      setError(errorMessage(e, 'Action failed'));
      return false;
    }
  };

  const create = async (e) => {
    e.preventDefault();
    if (await run(() => createUser(form))) setForm(NEW_USER);
  };

  return (
    <div className="panel-page panel-wide">
      <section className="glass card panel-card">
        <h2 className="card-title">Users</h2>
        {accounts.error && <ErrorNote>{errorMessage(accounts.error, 'Could not load users')}</ErrorNote>}
        <table className="users-table">
          <thead>
            <tr><th>Username</th><th>Email</th><th>Role</th><th>Active</th><th>Password</th></tr>
          </thead>
          <tbody>
            {(accounts.data ?? []).map(u => {
              const self = u.id === me?.id;
              return (
                <tr key={u.id} data-inactive={!u.is_active}>
                  <td>{u.username}</td>
                  <td className="muted">{u.email}</td>
                  <td>
                    <select name="role" aria-label={`Role for ${u.username}`} className="role-select" value={u.role} disabled={self}
                      onChange={e => run(() => updateUser(u.id, { role: e.target.value }))}>
                      {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </td>
                  <td>
                    <input type="checkbox" name="is_active" aria-label={`Active ${u.username}`} checked={u.is_active} disabled={self}
                      onChange={e => run(() => updateUser(u.id, { is_active: e.target.checked }))} />
                  </td>
                  <td><ResetPassword username={u.username} onSave={(password) => run(() => updateUser(u.id, { password }))} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {error && <ErrorNote>{error}</ErrorNote>}
      </section>

      <form className="glass card panel-card" onSubmit={create}>
        <h2 className="card-title">Create user</h2>
        <div className="injector-pair">
          <Field label="Username">{id => <input id={id} name="username" autoComplete="off" value={form.username} onChange={set('username')} />}</Field>
          <Field label="Email">{id => <input id={id} name="email" type="email" autoComplete="off" value={form.email} onChange={set('email')} />}</Field>
          <Field label="Password">{id => <input id={id} name="password" type="password" autoComplete="new-password" value={form.password} onChange={set('password')} />}</Field>
          <Field label="Role">
            {id => (
              <select id={id} name="role" value={form.role} onChange={set('role')}>
                {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
            )}
          </Field>
        </div>
        <button type="submit" className="btn btn-primary">Create user</button>
      </form>
    </div>
  );
}
