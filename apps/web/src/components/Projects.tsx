'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiGet, apiPost, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/context/AuthContext';
import type { Project } from '@/lib/types';

// Projects list + create.
//
// The create form only appears for platform admins — but that is a courtesy,
// not a control. POST /api/projects calls requirePlatformAdmin() regardless, so
// hiding the button changes nothing about who can actually create a project.
// ML Studio inverted this: its admin pages redirect in a useEffect and the
// underlying writes were open to any signed-in user.

export default function Projects() {
  const { profile } = useAuth();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);

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
    if (!name.trim() || busy) return;

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
    <div className="card stack">
      <div className="row between">
        <h2>Projects</h2>
        {isAdmin && !creating && (
          <button className="btn small" onClick={() => setCreating(true)}>
            New project
          </button>
        )}
      </div>

      {creating && (
        <form className="stack gap" onSubmit={create}>
          <label className="field">
            <span>Client name</span>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Acme Inc."
              required
            />
          </label>
          <label className="field">
            <span>Website</span>
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://acme.com" />
          </label>
          <div className="row">
            <button className="btn primary small" type="submit" disabled={busy || !name.trim()}>
              {busy ? 'Creating…' : 'Create project'}
            </button>
            <button
              className="btn small"
              type="button"
              onClick={() => {
                setCreating(false);
                setError(null);
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {error && <p className="error">{error}</p>}

      {projects === null && <p className="muted small">Loading…</p>}

      {projects?.length === 0 && !creating && (
        <p className="muted">
          {isAdmin
            ? 'No projects yet. Each client gets one, holding the platform modules enabled for them — Reddit first.'
            : 'You have not been added to any projects yet. An administrator can grant you access.'}
        </p>
      )}

      {projects && projects.length > 0 && (
        <ul className="list">
          {projects.map((p) => (
            <li key={p.projectId} className="list-row">
              <div>
                <strong>{p.name}</strong>
                {p.clientWebsiteUrl && <div className="muted small">{p.clientWebsiteUrl}</div>}
              </div>
              <div className="row">
                {p.enabledModules?.map((m) => (
                  <span key={m} className="pill">
                    {m}
                  </span>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
