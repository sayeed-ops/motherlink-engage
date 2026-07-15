'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiGet, apiPost, apiFetch, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/context/AuthContext';
import { GLOBAL_ROLES, type GlobalRole } from '@/lib/types';

interface Row {
  uid: string;
  email: string;
  displayName: string;
  role: GlobalRole;
  status: string;
  lastLoginAt: string | null;
}

// User administration.
//
// "Invite" here means: create the account, then tell them. There is no token,
// no expiry, no code to type. They sign in with Google using the address you
// entered, and the server matches it. Nothing in this flow can leak, because
// nothing in it is secret.

export default function UsersAdmin() {
  const { profile } = useAuth();
  const [users, setUsers] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);

  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<GlobalRole>('member');
  const [sendEmail, setSendEmail] = useState(true);

  const isOwner = profile?.role === 'owner';

  const load = useCallback(async () => {
    setError(null);
    try {
      const { users } = await apiGet<{ users: Row[] }>('/api/users');
      setUsers(users);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load users.');
      setUsers([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !email.trim()) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await apiPost<{ created: boolean; emailed: boolean | null }>('/api/users', {
        email: email.trim(),
        displayName: name.trim() || undefined,
        role,
        sendEmail,
      });
      setNotice(
        `${res.created ? 'Added' : 'Updated'} ${email.trim()}.` +
          (sendEmail
            ? res.emailed
              ? ' Invite email sent.'
              : ' Email could not be sent — they can still sign in.'
            : ''),
      );
      setEmail('');
      setName('');
      setRole('member');
      setAdding(false);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add the user.');
    } finally {
      setBusy(false);
    }
  }

  async function changeRole(uid: string, next: GlobalRole) {
    setError(null);
    setNotice(null);
    try {
      await apiFetch(`/api/users/${uid}`, { method: 'PATCH', body: JSON.stringify({ role: next }) });
      setNotice('Role updated. They will need to sign out and back in for it to take effect.');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not change the role.');
    }
  }

  async function setStatus(uid: string, status: 'active' | 'disabled') {
    setError(null);
    setNotice(null);
    try {
      await apiFetch(`/api/users/${uid}`, { method: 'PATCH', body: JSON.stringify({ status }) });
      setNotice(
        status === 'disabled'
          ? 'Access revoked. Any signed-in session stops working within seconds.'
          : 'Access restored.',
      );
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not update access.');
    }
  }

  return (
    <div className="card stack">
      <div className="row between">
        <h2>People</h2>
        {!adding && (
          <button className="btn small" onClick={() => setAdding(true)}>
            Add person
          </button>
        )}
      </div>

      {adding && (
        <form className="stack gap" onSubmit={add}>
          <label className="field">
            <span>Email</span>
            <input
              autoFocus
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="teammate@motherlink.io"
              required
            />
          </label>
          <label className="field">
            <span>Name (optional)</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" />
          </label>
          <label className="field">
            <span>Platform role</span>
            <select value={role} onChange={(e) => setRole(e.target.value as GlobalRole)}>
              {GLOBAL_ROLES.filter((r) => r !== 'owner' || isOwner).map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
          <label className="check">
            <input type="checkbox" checked={sendEmail} onChange={(e) => setSendEmail(e.target.checked)} />
            <span>Email them a link</span>
          </label>
          <p className="muted small">
            They sign in with Google using this address — no password, no invite code. Access to a
            client&apos;s data is granted separately, per project.
          </p>
          <div className="row">
            <button className="btn primary small" type="submit" disabled={busy || !email.trim()}>
              {busy ? 'Adding…' : 'Add person'}
            </button>
            <button className="btn small" type="button" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {error && <p className="error">{error}</p>}
      {notice && <p className="notice">{notice}</p>}

      {users === null && <p className="muted small">Loading…</p>}

      {users && (
        <ul className="list">
          {users.map((u) => (
            <li key={u.uid} className="list-row">
              <div>
                <strong>{u.displayName}</strong>
                {u.uid === profile?.uid && <span className="muted small"> (you)</span>}
                <div className="muted small">{u.email}</div>
                <div className="muted small">
                  {u.lastLoginAt ? `Last seen ${new Date(u.lastLoginAt).toLocaleDateString()}` : 'Never signed in'}
                </div>
              </div>
              <div className="row">
                {u.status === 'disabled' && <span className="pill danger">disabled</span>}
                <select
                  value={u.role}
                  disabled={u.uid === profile?.uid || (u.role === 'owner' && !isOwner)}
                  onChange={(e) => changeRole(u.uid, e.target.value as GlobalRole)}
                >
                  {GLOBAL_ROLES.filter((r) => r !== 'owner' || isOwner).map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
                {u.uid !== profile?.uid &&
                  (u.status === 'disabled' ? (
                    <button className="btn small" onClick={() => setStatus(u.uid, 'active')}>
                      Restore
                    </button>
                  ) : (
                    <button className="btn small" onClick={() => setStatus(u.uid, 'disabled')}>
                      Revoke
                    </button>
                  ))}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
