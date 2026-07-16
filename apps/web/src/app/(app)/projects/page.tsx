'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Plus } from 'lucide-react';
import PageHeader from '@/components/PageHeader';
import { useAuth } from '@/lib/context/AuthContext';
import { useProjects } from '@/lib/useProjects';
import { apiPost, ApiError } from '@/lib/api';

export default function ProjectsPage() {
  const { profile } = useAuth();
  // Live: a project created below (or one you're newly added to) appears
  // without a manual reload.
  const { projects, error: loadError } = useProjects();
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');

  const isAdmin = profile?.role === 'owner' || profile?.role === 'admin';

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await apiPost('/api/projects', {
        name: name.trim(),
        clientWebsiteUrl: url.trim(),
        enabledModules: ['reddit'],
      });
      setName('');
      setUrl('');
      setCreating(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the project.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Projects"
        description="One per client. Each holds the platform modules enabled for them."
        action={
          isAdmin && !creating ? (
            <button className="btn btn-primary" onClick={() => setCreating(true)}>
              <Plus size={15} /> New project
            </button>
          ) : undefined
        }
      />

      <div className="sections">
        {creating && (
          <section className="card">
            <div className="card-head">
              <h3>New project</h3>
            </div>
            <form className="stack" onSubmit={create}>
              <label className="field">
                <span>Client name</span>
                <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Inc." required />
              </label>
              <label className="field">
                <span>Website</span>
                <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://acme.com" />
              </label>
              <div className="row">
                <button className="btn btn-primary btn-sm" type="submit" disabled={busy || !name.trim()}>
                  {busy ? 'Creating…' : 'Create project'}
                </button>
                <button className="btn btn-ghost btn-sm" type="button" onClick={() => setCreating(false)}>
                  Cancel
                </button>
              </div>
            </form>
          </section>
        )}

        {(error || loadError) && <p className="text-error small">{error ?? loadError}</p>}

        <section className="card">
          {projects === null && <p className="text-dim small">Loading…</p>}

          {projects?.length === 0 && (
            <div className="empty">
              <p>{isAdmin ? 'No projects yet.' : 'You have not been added to any projects.'}</p>
              <p className="text-dim small">
                {isAdmin
                  ? 'Create one per client. Reddit is the first module; Quora and LinkedIn follow.'
                  : 'An administrator can grant you access to a client workspace.'}
              </p>
            </div>
          )}

          {projects && projects.length > 0 && (
            <ul className="list">
              {projects.map((p) => (
                <li key={p.projectId} className="list-row">
                  <div>
                    <Link href={`/projects/${p.projectId}`} className="strong-link">
                      {p.name}
                    </Link>
                    {p.clientWebsiteUrl && <div className="text-dim small">{p.clientWebsiteUrl}</div>}
                  </div>
                  <div className="row">
                    {p.enabledModules?.map((m) => (
                      <span key={m} className="badge badge-primary">
                        {m}
                      </span>
                    ))}
                    {p.status === 'archived' && <span className="badge">archived</span>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}
