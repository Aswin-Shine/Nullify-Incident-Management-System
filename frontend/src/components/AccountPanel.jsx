import { useState } from 'react';
import { changePassword, rotateApiKey, errorMessage } from '../api/client';
import { useAuth } from '../context/auth';
import { ErrorNote } from './ErrorNote';
import { Field } from './Field';

const EMPTY = { current: '', next: '', confirm: '' };

function PasswordCard() {
  const { user, setUser } = useAuth();
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setError(''); setDone(false);
    if (form.next !== form.confirm) { setError('The new passwords do not match.'); return; }
    setBusy(true);
    try {
      const data = await changePassword(form.current, form.next);
      setUser(data.user);
      setForm(EMPTY);
      setDone(true);
    } catch (err) {
      setError(errorMessage(err, 'Could not change the password'));
    } finally { setBusy(false); }
  };

  return (
    <form className="panel card panel-card" onSubmit={submit}>
      <h2 className="card-title">Change password</h2>
      <p className="muted">At least 12 characters. Your other sessions are signed out.</p>
      {/* Lets password managers tie the new password to this account. */}
      <input type="text" name="username" autoComplete="username" value={user?.username ?? ''} readOnly hidden />
      <Field label="Current password">
        {id => <input id={id} name="current_password" type="password" autoComplete="current-password" value={form.current} onChange={set('current')} />}
      </Field>
      <Field label="New password">
        {id => <input id={id} name="new_password" type="password" autoComplete="new-password" value={form.next} onChange={set('next')} />}
      </Field>
      <Field label="Confirm new password">
        {id => <input id={id} name="confirm_password" type="password" autoComplete="new-password" value={form.confirm} onChange={set('confirm')} />}
      </Field>
      {error && <ErrorNote>{error}</ErrorNote>}
      {done && <div className="inject-status" data-status="success" role="status">Password changed.</div>}
      <button type="submit" className="btn btn-primary" disabled={busy}>Change password</button>
    </form>
  );
}

function ApiKeyCard() {
  const { user, setUser } = useAuth();
  const [key, setKey] = useState(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const generate = async () => {
    setError(''); setCopied(false); setConfirming(false);
    try {
      setKey((await rotateApiKey()).api_key);
      setUser(u => ({ ...u, has_api_key: true }));
    } catch (err) {
      setError(errorMessage(err, 'Could not generate a key'));
    }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(key); setCopied(true); } catch { setError('Copy failed, select the key and copy it by hand.'); }
  };

  return (
    <section className="panel card panel-card">
      <h2 className="card-title">API key</h2>
      <p className="muted">
        {user?.has_api_key
          ? 'You have a key; generating a new one disables it.'
          : 'No key yet. Send it as the X-API-Key header from a producer.'}
      </p>
      {key && (
        <div className="key-row">
          <input name="api_key" aria-label="New API key" readOnly value={key} onFocus={e => e.target.select()} />
          <button type="button" className="btn btn-secondary" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
        </div>
      )}
      {key && <div className="note-warn"><p>This key will not be shown again.</p></div>}
      {error && <ErrorNote>{error}</ErrorNote>}
      {confirming ? (
        <div className="key-confirm">
          <p>This disables your current key. Producers using it will start getting 401.</p>
          <div className="confirm-actions">
            <button type="button" className="btn btn-secondary" onClick={() => setConfirming(false)}>Cancel</button>
            <button type="button" className="btn btn-primary" onClick={generate}>Generate new key</button>
          </div>
        </div>
      ) : (
        <button type="button" className="btn btn-secondary" onClick={user?.has_api_key ? () => setConfirming(true) : generate}>Generate key</button>
      )}
    </section>
  );
}

// ponytail: no in-app preference store; the browser's own notification permission is the switch.
function AlertsCard() {
  const [permission, setPermission] = useState(Notification.permission);
  const enable = async () => setPermission(await Notification.requestPermission());

  return (
    <section className="panel card panel-card">
      <h2 className="card-title">Desktop alerts</h2>
      <p className="muted">Get a browser notification when a new P0 opens while this tab is in the background.</p>
      <p className="muted">Permission: {permission}{permission === 'denied' ? ' (change it in the browser site settings)' : ''}</p>
      <button type="button" className="btn btn-secondary" onClick={enable} disabled={permission !== 'default'}>
        Enable desktop alerts
      </button>
    </section>
  );
}

export function AccountPanel() {
  return (
    <div className="panel-page">
      <h1 className="page-title">Account</h1>
      <PasswordCard />
      <ApiKeyCard />
      {typeof Notification !== 'undefined' && <AlertsCard />}
    </div>
  );
}
