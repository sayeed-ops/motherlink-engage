'use client';

import { useCallback, useEffect, useState } from 'react';
import { UserPlus } from 'lucide-react';
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
// "Add person" means: create the account, then tell them. There is no token, no
// expiry, no code to type. They sign in with Google using the address you
// entered and the server matches it. Nothing here can leak, because nothing
// here is secret.

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

  const isOwner = profile?.role === 'owner';
  const roleOptions = GLOBAL_ROLES.filter((r) => r !== 'owner' || isOwner);

  const load = useCallback(async () => {
    setError(null);
    try {
      const { users } = await apiGet<{ users: Row[] }>('/api/users');
      setUsers(users);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load people.');
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
      const res = await apiPost<{ created: boolean }>('/api/users', {
        email: email.trim(),
        displayName: name.trim() || undefined,
        role,
        sendEmail: false,
      });
      setNotice(`${res.created ? 'Added' : 'Updated'} ${email.trim()}. They can sign in with Google now.`);
      setEmail('');
      setName('');
      setRole('member');
      setAdding(false);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add that person.');
    } finally {
      setBusy(false);
    }
  }

  async function patch(uid: string, body: Record<string, unknown>, message: string) {
    setError(null);
    setNotice(null);
    try {
      await apiFetch(`/api/users/${uid}`, { method: 'PATCH', body: JSON.stringify(body) });
      setNotice(message);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not update that person.');
    }
  }

  return (
    <div className="card">
      <div className="card-head">
        <h3>People</h3>
        {!adding && (
          <button className="btn btn-secondary btn-sm" onClick={() => setAdding(true)}>
            <UserPlus size={14} /> Add person
          </button>
        )}
      </div>

      {adding && (
        <form className="stack bordered" onSubmit={add}>
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
              {roleOptions.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
          <p className="text-muted small">
            They sign in with Google using this address — no password, no invite code. Access to a
            client&apos;s data is granted separately, on that project.
          </p>
          <div className="row">
            <button className="btn btn-primary btn-sm" type="submit" disabled={busy || !email.trim()}>
              {busy ? 'Adding…' : 'Add person'}
            </button>
            <button className="btn btn-ghost btn-sm" type="button" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {error && <p className="text-error small">{error}</p>}
      {notice && <p className="text-success small">{notice}</p>}

      {users === null && <p className="text-dim small">Loading…</p>}

      {users && (
        <ul className="list">
          {users.map((u) => (
            <li key={u.uid} className="list-row">
              <div>
                <strong>{u.displayName}</strong>
                {u.uid === profile?.uid && <span className="text-dim small"> (you)</span>}
                <div className="text-dim small">{u.email}</div>
                <div className="text-faint small">
                  {u.lastLoginAt
                    ? `Last seen ${new Date(u.lastLoginAt).toLocaleDateString()}`
                    : 'Never signed in'}
                </div>
              </div>
              <div className="row">
                {u.status === 'disabled' && <span className="badge badge-error">disabled</span>}
                <select
                  value={u.role}
                  disabled={u.uid === profile?.uid || (u.role === 'owner' && !isOwner)}
                  onChange={(e) =>
                    patch(
                      u.uid,
                      { role: e.target.value },
                      'Role updated. They must sign out and back in for it to take effect.',
                    )
                  }
                >
                  {roleOptions.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
                {u.uid !== profile?.uid &&
                  (u.status === 'disabled' ? (
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => patch(u.uid, { status: 'active' }, 'Access restored.')}
                    >
                      Restore
                    </button>
                  ) : (
                    <button
                      className="btn btn-danger btn-sm"
                      onClick={() =>
                        patch(
                          u.uid,
                          { status: 'disabled' },
                          'Access revoked. Any signed-in session stops working within seconds.',
                        )
                      }
                    >
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
