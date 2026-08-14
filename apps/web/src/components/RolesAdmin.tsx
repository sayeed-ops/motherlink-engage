'use client';

import { useCallback, useEffect, useState } from 'react';
import { Plus, Pencil, Trash2, Lock } from 'lucide-react';
import { apiGet, apiPost, apiPatch, apiFetch, ApiError } from '@/lib/api';
import PermissionCheckboxes from '@/components/PermissionCheckboxes';
import { PERMISSION_META, type Permission, type RoleSummary } from '@/lib/types';

// Role management.
//
// A role is a named, reusable permission set for the project member picker. The
// four built-ins (viewer/analyst/approver/manager) are read-only; admins add
// their own here. Granting a role copies its permissions onto the member — so
// editing a role never changes anyone's live access, it only changes what a
// future grant would give. That is stated on the page so it isn't a surprise.

type Draft = { name: string; description: string; permissions: Permission[] };

const EMPTY: Draft = { name: '', description: '', permissions: [] };

export default function RolesAdmin() {
  const [roles, setRoles] = useState<RoleSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // editingId: null = not editing, '' = creating new, else = editing that role.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);

  const load = useCallback(async () => {
    setError(null);
    try {
      const { roles } = await apiGet<{ roles: RoleSummary[] }>('/api/roles');
      setRoles(roles);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load roles.');
      setRoles([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function startCreate() {
    setDraft(EMPTY);
    setEditingId('');
    setError(null);
    setNotice(null);
  }

  function startEdit(role: RoleSummary) {
    setDraft({ name: role.name, description: role.description, permissions: [...role.permissions] });
    setEditingId(role.id);
    setError(null);
    setNotice(null);
  }

  function cancel() {
    setEditingId(null);
    setDraft(EMPTY);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!draft.name.trim()) return setError('A role name is required.');
    if (draft.permissions.length === 0) return setError('Pick at least one permission.');
    setBusy(true);
    setError(null);
    try {
      if (editingId) {
        await apiPatch(`/api/roles/${editingId}`, draft);
        setNotice(`Updated “${draft.name}”. Existing members keep what they already had.`);
      } else {
        await apiPost('/api/roles', draft);
        setNotice(`Created “${draft.name}”.`);
      }
      cancel();
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the role.');
    } finally {
      setBusy(false);
    }
  }

  async function remove(role: RoleSummary) {
    setError(null);
    setNotice(null);
    try {
      await apiFetch(`/api/roles/${role.id}`, { method: 'DELETE' });
      setNotice(`Deleted “${role.name}”. Members granted from it keep their access.`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete the role.');
    }
  }

  const custom = (roles ?? []).filter((r) => !r.builtIn);
  const builtIn = (roles ?? []).filter((r) => r.builtIn);

  const editor = (
    <form className="stack bordered" onSubmit={save}>
      <label className="field">
        <span>Role name</span>
        <input
          autoFocus
          value={draft.name}
          onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          placeholder="e.g. Drafter"
          required
        />
      </label>
      <label className="field">
        <span>Description (optional)</span>
        <input
          value={draft.description}
          onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
          placeholder="What this role is for"
        />
      </label>
      <div className="field">
        <span>Permissions</span>
        <PermissionCheckboxes
          value={draft.permissions}
          onChange={(permissions) => setDraft((d) => ({ ...d, permissions }))}
        />
      </div>
      {error && <p className="text-error small">{error}</p>}
      <div className="row">
        <button className="btn btn-primary btn-sm" type="submit" disabled={busy}>
          {busy ? 'Saving…' : editingId ? 'Save changes' : 'Create role'}
        </button>
        <button className="btn btn-ghost btn-sm" type="button" onClick={cancel}>
          Cancel
        </button>
      </div>
    </form>
  );

  return (
    <div className="stack">
      <div className="card">
        <div className="card-head">
          <h3>Custom roles</h3>
          {editingId === null && (
            <button className="btn btn-secondary btn-sm" onClick={startCreate}>
              <Plus size={14} /> New role
            </button>
          )}
        </div>

        {editingId === '' && editor}

        {error && editingId === null && <p className="text-error small">{error}</p>}
        {notice && <p className="text-success small">{notice}</p>}

        {roles === null && <p className="text-dim small">Loading…</p>}

        {roles && custom.length === 0 && editingId !== '' && (
          <p className="text-dim small">
            No custom roles yet. Create one to reuse a permission set across projects, or fine-tune a
            single person&apos;s actions right on their project instead.
          </p>
        )}

        {custom.length > 0 && (
          <ul className="list">
            {custom.map((r) =>
              editingId === r.id ? (
                <li key={r.id}>{editor}</li>
              ) : (
                <li key={r.id} className="list-row">
                  <div>
                    <strong>{r.name}</strong>
                    {r.description && <div className="text-dim small">{r.description}</div>}
                    <div className="text-faint small">
                      {r.permissions.length} permission{r.permissions.length === 1 ? '' : 's'}
                    </div>
                  </div>
                  <div className="row">
                    <button className="btn btn-secondary btn-sm" onClick={() => startEdit(r)}>
                      <Pencil size={13} /> Edit
                    </button>
                    <button
                      className="btn btn-danger btn-sm btn-icon"
                      onClick={() => remove(r)}
                      aria-label={`Delete ${r.name}`}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </li>
              ),
            )}
          </ul>
        )}
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Built-in roles</h3>
        </div>
        <p className="text-dim small">
          These always exist and can&apos;t be edited. Custom roles sit alongside them in the
          project member picker. Expand one to see exactly what it grants — and copy it into a
          custom role if you want a variation.
        </p>
        {/* This used to show only "{n} permissions", so the only way to learn
            what `analyst` actually granted was to read the source. A read-only
            list is the whole fix; editing stays blocked server-side. */}
        <ul className="list">
          {builtIn.map((r) => (
            <li key={r.id} className="stack" style={{ gap: 4 }}>
              <div className="list-row">
                <div>
                  <strong style={{ textTransform: 'capitalize' }}>{r.name}</strong>
                  <div className="text-dim small">{r.description}</div>
                </div>
                <span className="badge">
                  <Lock size={12} style={{ verticalAlign: '-2px', marginRight: 4 }} />
                  built-in
                </span>
              </div>
              <details className="small">
                <summary className="text-faint" style={{ cursor: 'pointer' }}>
                  {r.permissions.length} permission{r.permissions.length === 1 ? '' : 's'}
                </summary>
                <ul className="stack" style={{ gap: 3, margin: '6px 0 8px', paddingLeft: 18 }}>
                  {PERMISSION_META.filter((p) => r.permissions.includes(p.id)).map((p) => (
                    <li key={p.id}>
                      <strong>{p.label}</strong>
                      <span className="text-dim"> — {p.help}</span>
                    </li>
                  ))}
                </ul>
              </details>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
