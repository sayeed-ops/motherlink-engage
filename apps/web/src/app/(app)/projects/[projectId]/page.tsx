'use client';

import { use, useCallback, useEffect, useState } from 'react';
import { MessagesSquare, UserPlus, Trash2, Lock } from 'lucide-react';
import PageHeader from '@/components/PageHeader';
import { apiGet, apiPost, apiFetch, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/context/AuthContext';
import { PERMISSION_BUNDLES, type Project, type ProjectMember } from '@/lib/types';

// A client's workspace: its platform modules, and who can touch them.
//
// The member list here IS the authorization record — the same document security
// rules read on every request. Removing someone from this list removes their
// access immediately, with nothing cached and nothing to invalidate.

const BUNDLE_HELP: Record<string, string> = {
  viewer: 'Read the work. Cannot spend money or publish.',
  analyst: 'Fetch, analyse and draft. Cannot publish.',
  approver: 'Everything an analyst can do, plus approving and publishing.',
  manager: 'Full control of this client, including members and the danger zone.',
};

export default function ProjectPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = use(params);
  const { profile } = useAuth();

  const [project, setProject] = useState<Project | null>(null);
  const [members, setMembers] = useState<ProjectMember[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState('');
  const [bundle, setBundle] = useState('analyst');

  const isAdmin = profile?.role === 'owner' || profile?.role === 'admin';

  const load = useCallback(async () => {
    setError(null);
    try {
      const [{ projects }, { members }] = await Promise.all([
        apiGet<{ projects: Project[] }>('/api/projects'),
        apiGet<{ members: ProjectMember[] }>(`/api/projects/${projectId}/members`),
      ]);
      setProject(projects.find((p) => p.projectId === projectId) ?? null);
      setMembers(members);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load this project.');
      setMembers([]);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function addMember(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !email.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await apiPost(`/api/projects/${projectId}/members`, { email: email.trim(), bundle });
      setEmail('');
      setAdding(false);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add that person.');
    } finally {
      setBusy(false);
    }
  }

  async function remove(uid: string) {
    setError(null);
    try {
      await apiFetch(`/api/projects/${projectId}/members/${uid}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not remove that person.');
    }
  }

  if (!project && members === null) {
    return (
      <>
        <PageHeader title="Loading…" crumbs={[{ label: 'Projects', href: '/projects' }]} />
      </>
    );
  }

  if (!project) {
    return (
      <>
        <PageHeader title="Project not found" crumbs={[{ label: 'Projects', href: '/projects' }]} />
        <div className="panel">
          <div className="empty">
            <Lock size={20} className="dim" />
            <p>This project does not exist, or you do not have access to it.</p>
            <p className="muted small">
              Those are deliberately the same answer — knowing which would tell you a client exists.
            </p>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={project.name}
        description={project.clientWebsiteUrl || undefined}
        crumbs={[{ label: 'Projects', href: '/projects' }, { label: project.name }]}
      />

      <section className="panel">
        <div className="panel-head">
          <h2>Modules</h2>
        </div>
        <ul className="list">
          {project.enabledModules?.includes('reddit') && (
            <li className="list-row">
              <div className="row">
                <MessagesSquare size={16} className="dim" />
                <div>
                  <strong>Reddit</strong>
                  <div className="muted small">Find conversations, analyse fit, draft replies.</div>
                </div>
              </div>
              <span className="pill">soon</span>
            </li>
          )}
          <li className="list-row">
            <div className="row">
              <MessagesSquare size={16} className="dim" />
              <div>
                <strong className="muted">Quora</strong>
                <div className="muted small">Not built yet.</div>
              </div>
            </div>
            <span className="pill">planned</span>
          </li>
          <li className="list-row">
            <div className="row">
              <MessagesSquare size={16} className="dim" />
              <div>
                <strong className="muted">LinkedIn</strong>
                <div className="muted small">Not built yet.</div>
              </div>
            </div>
            <span className="pill">planned</span>
          </li>
        </ul>
      </section>

      <section className="panel">
        <div className="panel-head between">
          <h2>Access</h2>
          {!adding && (
            <button className="btn small" onClick={() => setAdding(true)}>
              <UserPlus size={14} /> Add person
            </button>
          )}
        </div>

        {adding && (
          <form className="stack gap bordered" onSubmit={addMember}>
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
              <span>Access level</span>
              <select value={bundle} onChange={(e) => setBundle(e.target.value)}>
                {Object.keys(PERMISSION_BUNDLES).map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </label>
            <p className="muted small">{BUNDLE_HELP[bundle]}</p>
            <p className="muted small dim">
              They must already have an Engage account. {isAdmin ? 'Add them under People first.' : 'Ask an admin to add them.'}
            </p>
            <div className="row">
              <button className="btn primary small" type="submit" disabled={busy || !email.trim()}>
                {busy ? 'Adding…' : 'Grant access'}
              </button>
              <button className="btn small" type="button" onClick={() => setAdding(false)}>
                Cancel
              </button>
            </div>
          </form>
        )}

        {error && <p className="error">{error}</p>}

        {members && members.length > 0 && (
          <ul className="list">
            {members.map((m) => (
              <li key={m.uid} className="list-row">
                <div>
                  <strong>{m.displayName}</strong>
                  {m.uid === profile?.uid && <span className="muted small"> (you)</span>}
                  <div className="muted small">{m.email}</div>
                </div>
                <div className="row">
                  <span className="pill">{m.grantedFromBundle ?? 'custom'}</span>
                  <span className="muted small">{m.permissions?.length ?? 0} permissions</span>
                  <button className="btn small icon" onClick={() => remove(m.uid)} aria-label={`Remove ${m.displayName}`}>
                    <Trash2 size={14} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        {members?.length === 0 && <p className="muted small">Nobody has access to this project yet.</p>}
      </section>
    </>
  );
}
