'use client';

import Link from 'next/link';
import { use, useCallback, useEffect, useState } from 'react';
import { MessagesSquare, UserPlus, Trash2, Lock, ArrowRight } from 'lucide-react';
import PageHeader from '@/components/PageHeader';
import { apiGet, apiPost, apiFetch, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/context/AuthContext';
import { PERMISSION_BUNDLES, type Project, type ProjectMember } from '@/lib/types';

// A client's workspace: its platform modules, and who can touch them.
//
// The member list here IS the authorization record — the same document
// security rules read on every request. Removing someone removes their access
// immediately, with nothing cached and nothing to invalidate.

const BUNDLE_HELP: Record<string, string> = {
  viewer: 'Read the work. Cannot spend money or publish.',
  analyst: 'Fetch, analyse and draft. Cannot publish.',
  approver: 'Everything an analyst can do, plus approving and publishing.',
  manager: 'Full control of this client, including members and the danger zone.',
};

const MODULES = [
  { id: 'reddit', name: 'Reddit', blurb: 'Find conversations, analyse fit, draft replies.' },
  { id: 'quora', name: 'Quora', blurb: 'Not built yet.' },
  { id: 'linkedin', name: 'LinkedIn', blurb: 'Not built yet.' },
] as const;

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
    return <PageHeader title="Loading…" crumbs={[{ label: 'Projects', href: '/projects' }]} />;
  }

  if (!project) {
    return (
      <>
        <PageHeader title="Project not found" crumbs={[{ label: 'Projects', href: '/projects' }]} />
        <div className="card">
          <div className="empty">
            <Lock size={20} className="text-faint" />
            <p>This project does not exist, or you do not have access to it.</p>
            <p className="text-dim small">
              Those are deliberately the same answer — knowing which would confirm a client exists.
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

      <div className="sections">
        <section className="card">
          <div className="card-head">
            <h3>Modules</h3>
          </div>
          <ul className="list">
            {MODULES.map((m) => {
              const enabled = project.enabledModules?.includes(m.id as never);
              const live = enabled && m.id === 'reddit';
              return (
                <li key={m.id} className="list-row">
                  <div className="row">
                    <MessagesSquare size={16} className={live ? 'text-primary' : 'text-faint'} />
                    <div>
                      {live ? (
                        <Link href={`/projects/${projectId}/reddit`} className="strong-link">
                          {m.name}
                        </Link>
                      ) : (
                        <strong className="text-dim">{m.name}</strong>
                      )}
                      <div className="text-dim small">{m.blurb}</div>
                    </div>
                  </div>
                  {live ? (
                    <Link href={`/projects/${projectId}/reddit`} className="btn btn-secondary btn-sm">
                      Open <ArrowRight size={13} />
                    </Link>
                  ) : (
                    <span className="badge">planned</span>
                  )}
                </li>
              );
            })}
          </ul>
        </section>

        <section className="card">
          <div className="card-head">
            <h3>Access</h3>
            {!adding && (
              <button className="btn btn-secondary btn-sm" onClick={() => setAdding(true)}>
                <UserPlus size={14} /> Add person
              </button>
            )}
          </div>

          {adding && (
            <form className="stack bordered" onSubmit={addMember}>
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
              <p className="text-muted small">{BUNDLE_HELP[bundle]}</p>
              <p className="text-faint small">
                They must already have an Engage account.{' '}
                {isAdmin ? 'Add them under People first.' : 'Ask an admin to add them.'}
              </p>
              <div className="row">
                <button className="btn btn-primary btn-sm" type="submit" disabled={busy || !email.trim()}>
                  {busy ? 'Adding…' : 'Grant access'}
                </button>
                <button className="btn btn-ghost btn-sm" type="button" onClick={() => setAdding(false)}>
                  Cancel
                </button>
              </div>
            </form>
          )}

          {error && <p className="text-error small">{error}</p>}

          {members && members.length > 0 && (
            <ul className="list">
              {members.map((m) => (
                <li key={m.uid} className="list-row">
                  <div>
                    <strong>{m.displayName}</strong>
                    {m.uid === profile?.uid && <span className="text-dim small"> (you)</span>}
                    <div className="text-dim small">{m.email}</div>
                  </div>
                  <div className="row">
                    <span className="badge badge-no-dot badge-solid">{m.grantedFromBundle ?? 'custom'}</span>
                    <span className="text-dim small">{m.permissions?.length ?? 0} permissions</span>
                    <button
                      className="btn btn-danger btn-sm btn-icon"
                      onClick={() => remove(m.uid)}
                      aria-label={`Remove ${m.displayName}`}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {members?.length === 0 && <p className="text-dim small">Nobody has access to this project yet.</p>}
        </section>
      </div>
    </>
  );
}
