'use client';

import { useEffect, useState } from 'react';
import PageHeader from '@/components/PageHeader';
import { useAuth } from '@/lib/context/AuthContext';
import { apiFetch, ApiError } from '@/lib/api';

export default function ProfilePage() {
  const { profile, firebaseUser, refresh } = useAuth();
  const [name, setName] = useState('');
  const [avatar, setAvatar] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (profile) {
      setName(profile.displayName ?? '');
      setAvatar(profile.avatarUrl ?? '');
    }
  }, [profile]);

  const dirty = profile
    ? name !== (profile.displayName ?? '') || avatar !== (profile.avatarUrl ?? '')
    : false;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !dirty) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await apiFetch('/api/profile', {
        method: 'PATCH',
        body: JSON.stringify({ displayName: name.trim(), avatarUrl: avatar.trim() || null }),
      });
      await refresh();
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save your profile.');
    } finally {
      setBusy(false);
    }
  }

  const provider = firebaseUser?.providerData?.[0]?.providerId === 'google.com' ? 'Google' : 'Email';

  return (
    <>
      <PageHeader title="Your profile" description="How you appear to the rest of the team." />

      <div className="sections">
        <section className="card">
          <div className="card-head">
            <h3>Details</h3>
          </div>
          <form className="stack" onSubmit={save}>
            <label className="field">
              <span>Name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required />
            </label>

            <label className="field">
              <span>Avatar URL</span>
              <input
                value={avatar}
                onChange={(e) => setAvatar(e.target.value)}
                placeholder="https://…"
                type="url"
              />
              <span className="text-dim small">Must be https. Leave blank for none.</span>
            </label>

            {error && <p className="text-error small">{error}</p>}
            {saved && !dirty && <p className="text-success small">Saved.</p>}

            <div className="row">
              <button className="btn btn-primary btn-sm" type="submit" disabled={busy || !dirty}>
                {busy ? 'Saving…' : 'Save changes'}
              </button>
            </div>
          </form>
        </section>

        <section className="card">
          <div className="card-head">
            <h3>Account</h3>
          </div>
          <ul className="list">
            <li className="list-row">
              <span className="text-muted small">Email</span>
              <span className="text-mono small">{profile?.email}</span>
            </li>
            <li className="list-row">
              <span className="text-muted small">Signed in with</span>
              <span className="small">{provider}</span>
            </li>
            <li className="list-row">
              <span className="text-muted small">Platform role</span>
              <span className="badge badge-primary">{profile?.role}</span>
            </li>
            <li className="list-row">
              <span className="text-muted small">Status</span>
              <span className="badge badge-success">{profile?.status}</span>
            </li>
          </ul>
          <p className="text-dim small" style={{ marginTop: 12 }}>
            Your email and platform role are set by an administrator. Your role governs platform-wide
            actions; access to each client&apos;s data is granted per project.
          </p>
        </section>
      </div>
    </>
  );
}
