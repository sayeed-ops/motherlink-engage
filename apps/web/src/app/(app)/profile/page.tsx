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

  const dirty = profile ? name !== (profile.displayName ?? '') || avatar !== (profile.avatarUrl ?? '') : false;

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

  return (
    <>
      <PageHeader title="Your profile" description="How you appear to the rest of the team." />

      <section className="panel">
        <form className="stack gap" onSubmit={save}>
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
            <span className="muted small">Must be https. Leave blank for none.</span>
          </label>

          {error && <p className="error">{error}</p>}
          {saved && !dirty && <p className="notice">Saved.</p>}

          <div className="row">
            <button className="btn primary small" type="submit" disabled={busy || !dirty}>
              {busy ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </form>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Account</h2>
        </div>
        <dl className="kv">
          <dt>Email</dt>
          <dd>{profile?.email}</dd>
          <dt>Signed in with</dt>
          <dd>{firebaseUser?.providerData?.[0]?.providerId === 'google.com' ? 'Google' : 'Email'}</dd>
          <dt>Platform role</dt>
          <dd>
            <span className="pill">{profile?.role}</span>
          </dd>
          <dt>Status</dt>
          <dd>{profile?.status}</dd>
          <dt>Last signed in</dt>
          <dd>
            {profile?.lastLoginAt ? new Date(profile.lastLoginAt as unknown as string).toLocaleString() : '—'}
          </dd>
        </dl>
        <p className="muted small">
          Your email and platform role are set by an administrator. Your role governs platform-wide
          actions; access to each client&apos;s data is granted per project.
        </p>
      </section>
    </>
  );
}
