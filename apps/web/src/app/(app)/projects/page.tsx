'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import PageHeader from '@/components/PageHeader';
import { useAuth } from '@/lib/context/AuthContext';
import { apiGet, apiPost, ApiError } from '@/lib/api';
import type { Project } from '@/lib/types';

export default function ProjectsPage() {
  const { profile } = useAuth();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');

  const isAdmin = profile?.role === 'owner' || profile?.role === 'admin';

  const load = useCallback(async () => {
    setError(null);
    try {
      const { projects } = await apiGet<{ projects: Project[] }>('/api/projects');
      setProjects(projects);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load projects.');
      setProjects([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

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
      await load();
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
            <button className="btn primary" onClick={() => setCreating(true)}>
              <Plus size={15} /> New project
            </button>
          ) : undefined
        }
      />

      {creating && (
        <section className="panel">
          <div className="panel-head">
            <h2>New project</h2>
          </div>
          <form className="stack gap" onSubmit={create}>
            <label className="field">
              <span>Client name</span>
              <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Inc." required />
            </label>
            <label className="field">
              <span>Website</span>
              <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://acme.com" />
            </label>
            <div className="row">
              <button className="btn primary small" type="submit" disabled={busy || !name.trim()}>
                {busy ? 'Creating…' : 'Create project'}
              </button>
              <button className="btn small" type="button" onClick={() => setCreating(false)}>
                Cancel
              </button>
            </div>
          </form>
        </section>
      )}

      {error && <p className="error">{error}</p>}

      <section className="panel">
        {projects === null && <p className="muted small">Loading…</p>}

        {projects?.length === 0 && (
          <div className="empty">
            <p>{isAdmin ? 'No projects yet.' : 'You have not been added to any projects.'}</p>
            <p className="muted small">
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
                  {p.clientWebsiteUrl && <div className="muted small">{p.clientWebsiteUrl}</div>}
                </div>
                <div className="row">
                  {p.enabledModules?.map((m) => (
                    <span key={m} className="pill">
                      {m}
                    </span>
                  ))}
                  {p.status === 'archived' && <span className="pill">archived</span>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
