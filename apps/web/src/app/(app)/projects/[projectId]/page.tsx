'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { use, useCallback, useEffect, useState } from 'react';
import { MessagesSquare, UserPlus, Trash2, Lock, ArrowRight, Eraser, AlertTriangle, SlidersHorizontal } from 'lucide-react';
import PageHeader from '@/components/PageHeader';
import PermissionCheckboxes from '@/components/PermissionCheckboxes';
import { apiGet, apiPost, apiPatch, apiFetch, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/context/AuthContext';
import { builtInRoles, type Permission, type Project, type ProjectMember, type RoleSummary } from '@/lib/types';

interface DirectoryPerson {
  uid: string;
  email: string;
  displayName: string;
}

// A client's workspace: its platform modules, and who can touch them.
//
// The member list here IS the authorization record — the same document
// security rules read on every request. Removing someone removes their access
// immediately, with nothing cached and nothing to invalidate.
//
// Access is granted from a role (built-in or custom, defined under /roles) and
// can then be fine-tuned per person with the "Adjust" editor, which ticks or
// unticks individual actions independent of any role.

const MODULES = [
  { id: 'reddit', name: 'Reddit', blurb: 'Find conversations, analyse fit, draft replies.' },
  { id: 'quora', name: 'Quora', blurb: 'Not built yet.' },
  { id: 'linkedin', name: 'LinkedIn', blurb: 'Not built yet.' },
] as const;

export default function ProjectPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = use(params);
  const { profile } = useAuth();
  const router = useRouter();

  const [project, setProject] = useState<Project | null>(null);
  const [members, setMembers] = useState<ProjectMember[] | null>(null);
  const [roles, setRoles] = useState<RoleSummary[]>(builtInRoles());
  const [people, setPeople] = useState<DirectoryPerson[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pickedUid, setPickedUid] = useState('');
  const [roleId, setRoleId] = useState('analyst');

  // Per-member granular editor: which member's actions are open, and the working
  // permission set for them.
  const [editingUid, setEditingUid] = useState<string | null>(null);
  const [editPerms, setEditPerms] = useState<Permission[]>([]);
  const [editBusy, setEditBusy] = useState(false);

  // Danger zone: destructive, so each action is behind a type-to-confirm gate.
  const [cleanText, setCleanText] = useState('');
  const [deleteText, setDeleteText] = useState('');
  const [dangerBusy, setDangerBusy] = useState<'clean' | 'delete' | null>(null);
  const [cleanResult, setCleanResult] = useState<string | null>(null);

  const isAdmin = profile?.role === 'owner' || profile?.role === 'admin';

  const load = useCallback(async () => {
    setError(null);
    try {
      const [{ projects }, { members }, rolesRes, peopleRes] = await Promise.all([
        apiGet<{ projects: Project[] }>('/api/projects'),
        apiGet<{ members: ProjectMember[] }>(`/api/projects/${projectId}/members`),
        apiGet<{ roles: RoleSummary[] }>('/api/roles').catch(() => ({ roles: builtInRoles() })),
        apiGet<{ people: DirectoryPerson[] }>('/api/directory').catch(() => ({ people: [] })),
      ]);
      setProject(projects.find((p) => p.projectId === projectId) ?? null);
      setMembers(members);
      setRoles(rolesRes.roles.length ? rolesRes.roles : builtInRoles());
      setPeople(peopleRes.people);
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
    const person = people.find((p) => p.uid === pickedUid);
    if (busy || !person) return;
    setBusy(true);
    setError(null);
    try {
      const role = roles.find((r) => r.id === roleId);
      // Built-in roles are granted by name (bundle); custom by id (roleId).
      const grant = role?.builtIn ? { bundle: role.id } : { roleId };
      await apiPost(`/api/projects/${projectId}/members`, { email: person.email, ...grant });
      setPickedUid('');
      setAdding(false);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add that person.');
    } finally {
      setBusy(false);
    }
  }

  function startEditMember(m: ProjectMember) {
    setEditingUid(m.uid);
    setEditPerms((m.permissions ?? []) as Permission[]);
    setError(null);
  }

  async function saveMemberPerms(uid: string) {
    if (editBusy) return;
    setEditBusy(true);
    setError(null);
    try {
      await apiPatch(`/api/projects/${projectId}/members/${uid}`, {
        permissions: editPerms,
        roleLabel: 'custom',
      });
      setEditingUid(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not update permissions.');
    } finally {
      setEditBusy(false);
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

  async function cleanHistory() {
    if (dangerBusy) return;
    setDangerBusy('clean');
    setError(null);
    setCleanResult(null);
    try {
      const r = await apiPost<{ items: number; analyses: number; drafts: number; postedDraftsKept: number }>(
        `/api/projects/${projectId}/reddit/clean`,
        {},
      );
      setCleanResult(
        `Cleared ${r.items} posts, ${r.analyses} analyses and ${r.drafts} unposted drafts.` +
          (r.postedDraftsKept ? ` Kept ${r.postedDraftsKept} posted repl${r.postedDraftsKept === 1 ? 'y' : 'ies'}.` : ''),
      );
      setCleanText('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not clean history.');
    } finally {
      setDangerBusy(null);
    }
  }

  async function deleteProject() {
    if (dangerBusy) return;
    setDangerBusy('delete');
    setError(null);
    try {
      await apiFetch(`/api/projects/${projectId}`, { method: 'DELETE' });
      router.push('/projects');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete the project.');
      setDangerBusy(null);
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

  // The danger zone needs project.settings on THIS project (or platform admin).
  // A platform admin is often not a member, so fall back to the global role.
  const myPerms = members?.find((m) => m.uid === profile?.uid)?.permissions ?? [];
  const canDanger = isAdmin || myPerms.includes('project.settings');
  const redditEnabled = project.enabledModules?.includes('reddit');

  // People who can still be added: everyone in the directory who isn't already a
  // member of this project.
  const memberUids = new Set(members?.map((m) => m.uid));
  const candidates = people.filter((p) => !memberUids.has(p.uid));

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
                <span>Person</span>
                {candidates.length > 0 ? (
                  <select autoFocus value={pickedUid} onChange={(e) => setPickedUid(e.target.value)} required>
                    <option value="" disabled>
                      Select a person…
                    </option>
                    {candidates.map((p) => (
                      <option key={p.uid} value={p.uid}>
                        {p.displayName} — {p.email}
                      </option>
                    ))}
                  </select>
                ) : (
                  <p className="text-dim small" style={{ margin: 0 }}>
                    {people.length === 0
                      ? 'No people to add yet.'
                      : 'Everyone on Engage already has access to this project.'}{' '}
                    {isAdmin ? (
                      <Link href="/people" className="strong-link">
                        Add someone under People
                      </Link>
                    ) : (
                      'Ask an admin to add them under People.'
                    )}
                  </p>
                )}
              </label>
              <label className="field">
                <span>Role</span>
                <select value={roleId} onChange={(e) => setRoleId(e.target.value)}>
                  {roles.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                      {r.builtIn ? '' : ' (custom)'}
                    </option>
                  ))}
                </select>
              </label>
              <p className="text-muted small">
                {roles.find((r) => r.id === roleId)?.description || 'A custom role.'}
                {isAdmin && ' You can add roles under Roles, or fine-tune each person after adding them.'}
              </p>
              <div className="row">
                <button
                  className="btn btn-primary btn-sm"
                  type="submit"
                  disabled={busy || !pickedUid}
                >
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
                <li key={m.uid} className={editingUid === m.uid ? '' : 'list-row'}>
                  {editingUid === m.uid ? (
                    <div className="stack bordered">
                      <div>
                        <strong>{m.displayName}</strong>
                        <div className="text-dim small">
                          Tick the exact actions {m.uid === profile?.uid ? 'you' : 'they'} may take on this
                          project.
                        </div>
                      </div>
                      <PermissionCheckboxes value={editPerms} onChange={setEditPerms} disabled={editBusy} />
                      <div className="row">
                        <button
                          className="btn btn-primary btn-sm"
                          onClick={() => saveMemberPerms(m.uid)}
                          disabled={editBusy}
                        >
                          {editBusy ? 'Saving…' : 'Save permissions'}
                        </button>
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => setEditingUid(null)}
                          disabled={editBusy}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div>
                        <strong>{m.displayName}</strong>
                        {m.uid === profile?.uid && <span className="text-dim small"> (you)</span>}
                        <div className="text-dim small">{m.email}</div>
                      </div>
                      <div className="row">
                        <span className="badge badge-no-dot badge-solid">{m.grantedFromBundle ?? 'custom'}</span>
                        <span className="text-dim small">{m.permissions?.length ?? 0} permissions</span>
                        <button
                          className="btn btn-secondary btn-sm"
                          onClick={() => startEditMember(m)}
                          aria-label={`Adjust ${m.displayName}'s permissions`}
                        >
                          <SlidersHorizontal size={13} /> Adjust
                        </button>
                        <button
                          className="btn btn-danger btn-sm btn-icon"
                          onClick={() => remove(m.uid)}
                          aria-label={`Remove ${m.displayName}`}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}

          {members?.length === 0 && <p className="text-dim small">Nobody has access to this project yet.</p>}
        </section>

        {canDanger && (
          <section className="card">
            <div className="card-head">
              <h3 className="text-error">
                <AlertTriangle size={15} style={{ verticalAlign: '-2px', marginRight: 6 }} />
                Danger zone
              </h3>
            </div>

            <div className="stack">
              {redditEnabled && (
                <div className="bordered stack">
                  <div>
                    <strong>Clear Reddit history</strong>
                    <p className="text-dim small">
                      Deletes every fetched post, its analyses, and any draft not marked posted. Keeps
                      knowledge sources, settings, and posted (answered) replies. Cannot be undone.
                    </p>
                  </div>
                  {cleanResult && <p className="text-success small">{cleanResult}</p>}
                  <div className="row">
                    <input
                      value={cleanText}
                      onChange={(e) => setCleanText(e.target.value)}
                      placeholder="Type “clean” to confirm"
                      aria-label="Type clean to confirm"
                      style={{ maxWidth: 220 }}
                    />
                    <button
                      className="btn btn-danger btn-sm"
                      onClick={cleanHistory}
                      disabled={dangerBusy !== null || cleanText.trim().toLowerCase() !== 'clean'}
                    >
                      <Eraser size={13} /> {dangerBusy === 'clean' ? 'Clearing…' : 'Clear history'}
                    </button>
                  </div>
                </div>
              )}

              <div className="bordered stack">
                <div>
                  <strong>Delete this project</strong>
                  <p className="text-dim small">
                    Removes the project and everything under it — members, settings, knowledge, posts,
                    analyses and drafts. There is no recovery.
                  </p>
                </div>
                <div className="row">
                  <input
                    value={deleteText}
                    onChange={(e) => setDeleteText(e.target.value)}
                    placeholder={`Type “${project.name}” to confirm`}
                    aria-label="Type the project name to confirm"
                    style={{ maxWidth: 280 }}
                  />
                  <button
                    className="btn btn-danger btn-sm"
                    onClick={deleteProject}
                    disabled={dangerBusy !== null || deleteText.trim() !== project.name}
                  >
                    <Trash2 size={13} /> {dangerBusy === 'delete' ? 'Deleting…' : 'Delete project'}
                  </button>
                </div>
              </div>
            </div>
          </section>
        )}
      </div>
    </>
  );
}
