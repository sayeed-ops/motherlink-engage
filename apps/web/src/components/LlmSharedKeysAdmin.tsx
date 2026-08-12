'use client';

import { useCallback, useEffect, useState } from 'react';
import { Trash2, RefreshCw, Check, AlertTriangle, Users } from 'lucide-react';
import { apiGet, apiPost, apiFetch, ApiError } from '@/lib/api';
import { PROVIDERS } from '@/lib/llm/catalog';
import type { MaskedCredential } from '@/components/LlmCredentialsAdmin';
import EncryptionNotice from '@/components/EncryptionNotice';

// Shared organisation keys and which projects may spend them. Admins only.
//
// Grants are per PROJECT rather than per person, so they compose with
// projects/{pid}/members — the thing that already answers "who may work on
// this". Everyone on a granted project can use the key; nobody else can.

interface ProjectRow {
  projectId: string;
  name?: string;
}

export default function LlmSharedKeysAdmin() {
  const [creds, setCreds] = useState<MaskedCredential[]>([]);
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [configured, setConfigured] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [openGrants, setOpenGrants] = useState<string | null>(null);

  const [provider, setProvider] = useState<string>(PROVIDERS[0]?.id ?? 'deepseek');
  const [label, setLabel] = useState('');
  const [apiKey, setApiKey] = useState('');

  const load = useCallback(async () => {
    try {
      const [c, p] = await Promise.all([
        apiGet<{ shared: MaskedCredential[]; encryptionConfigured: boolean }>('/api/llm/credentials'),
        apiGet<{ projects: ProjectRow[] }>('/api/projects'),
      ]);
      setCreds(c.shared ?? []);
      setConfigured(c.encryptionConfigured);
      setProjects(p.projects ?? []);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load shared keys.');
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const r = await apiPost<{ credential: MaskedCredential }>('/api/llm/credentials', {
        provider,
        label: label.trim(),
        apiKey: apiKey.trim(),
        scope: 'shared',
      });
      setNotice(
        `Shared key saved — it reaches ${r.credential.modelCount} model${r.credential.modelCount === 1 ? '' : 's'}. Grant it to a project below.`,
      );
      setLabel('');
      setApiKey('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save that key.');
    } finally {
      setBusy(false);
    }
  }

  async function saveGrants(c: MaskedCredential, projectIds: string[], all: boolean) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await apiFetch(`/api/llm/credentials/${c.credentialId}/grants`, {
        method: 'PUT',
        body: JSON.stringify({ grantedProjectIds: projectIds, grantAllProjects: all }),
      });
      setNotice(
        all
          ? `“${c.label}” is now available to every project.`
          : `“${c.label}” is available to ${projectIds.length} project${projectIds.length === 1 ? '' : 's'}.`,
      );
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save access.');
    } finally {
      setBusy(false);
    }
  }

  async function act(c: MaskedCredential, kind: 'delete' | 'verify') {
    if (kind === 'delete' && !confirm(`Remove the shared key “${c.label}”? Projects using it fall back to the platform key.`)) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (kind === 'delete') {
        await apiFetch(`/api/llm/credentials/${c.credentialId}`, { method: 'DELETE' });
        setNotice(`Removed “${c.label}”.`);
      } else {
        const r = await apiPost<{ ok: boolean; error: string | null }>(
          `/api/llm/credentials/${c.credentialId}/verify`,
          {},
        );
        setNotice(r.ok ? `“${c.label}” is working.` : `“${c.label}” failed: ${r.error}`);
      }
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  }

  // Show the setup state instead of an inviting form that cannot succeed. The
  // personal-keys card already did this; the shared one letting an admin paste a
  // live key only to reject it was the worse version of the same bug.
  if (loaded && !configured) {
    return (
      <section className="card">
        <div className="card-head">
          <h3>Shared keys</h3>
        </div>
        <EncryptionNotice />
      </section>
    );
  }

  return (
    <section className="card">
      <div className="card-head">
        <h3>Shared keys</h3>
      </div>
      <p className="text-dim small">
        Organisation keys you grant to specific projects. Anyone working on a granted project uses the key
        without needing their own. A shared key bills the organisation, so grant it deliberately.
      </p>

      {!loaded ? (
        <p className="text-dim small">Loading…</p>
      ) : creds.length === 0 ? (
        <p className="text-dim small">No shared keys yet.</p>
      ) : (
        <div className="list">
          {creds.map((c) => (
            <div key={c.credentialId} className="stack" style={{ gap: 6 }}>
              <div className="list-row">
                <span className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
                  <strong>{c.label}</strong>
                  <span className="badge">{c.provider}</span>
                  <span className="text-dim small">{c.keyHint}</span>
                  <span className="text-dim small">
                    {c.grantAllProjects
                      ? 'all projects'
                      : `${c.grantedProjectIds.length} project${c.grantedProjectIds.length === 1 ? '' : 's'}`}
                  </span>
                  {c.status === 'invalid' && (
                    <span className="badge badge-warning">
                      <AlertTriangle size={11} style={{ verticalAlign: '-1px' }} /> not working
                    </span>
                  )}
                </span>
                <span className="row small" style={{ gap: 8 }}>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => setOpenGrants(openGrants === c.credentialId ? null : c.credentialId)}
                    disabled={busy}
                  >
                    <Users size={13} /> Access
                  </button>
                  <button className="btn btn-secondary btn-sm" onClick={() => act(c, 'verify')} disabled={busy}>
                    <RefreshCw size={13} /> Re-check
                  </button>
                  <button className="btn btn-ghost btn-sm" onClick={() => act(c, 'delete')} disabled={busy}>
                    <Trash2 size={13} /> Remove
                  </button>
                </span>
              </div>

              {openGrants === c.credentialId && (
                <GrantEditor
                  credential={c}
                  projects={projects}
                  busy={busy}
                  onSave={(ids, all) => saveGrants(c, ids, all)}
                />
              )}
            </div>
          ))}
        </div>
      )}

      <form className="stack" onSubmit={add} style={{ marginTop: 14 }}>
        <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label className="field" style={{ maxWidth: 180 }}>
            <span>Provider</span>
            <select value={provider} onChange={(e) => setProvider(e.target.value)}>
              {PROVIDERS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field" style={{ maxWidth: 220 }}>
            <span>Label</span>
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Motherlink OpenRouter" />
          </label>
          <label className="field" style={{ maxWidth: 320 }}>
            <span>API key</span>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={PROVIDERS.find((p) => p.id === provider)?.keyHint ?? ''}
              autoComplete="off"
            />
          </label>
          <button className="btn btn-primary btn-sm" disabled={busy || !label.trim() || !apiKey.trim()}>
            {busy ? 'Checking…' : 'Add shared key'}
          </button>
        </div>
      </form>

      {error && <p className="text-error small">{error}</p>}
      {notice && (
        <p className="text-success small">
          <Check size={12} style={{ verticalAlign: '-1px' }} /> {notice}
        </p>
      )}
    </section>
  );
}

/** Project checkboxes for one shared key. Local state so an admin can tick
 *  several projects and save once, rather than firing a write per checkbox. */
function GrantEditor({
  credential,
  projects,
  busy,
  onSave,
}: {
  credential: MaskedCredential;
  projects: ProjectRow[];
  busy: boolean;
  onSave: (projectIds: string[], all: boolean) => void;
}) {
  const [all, setAll] = useState(credential.grantAllProjects);
  const [ids, setIds] = useState<string[]>(credential.grantedProjectIds);

  const toggle = (projectId: string) =>
    setIds((cur) => (cur.includes(projectId) ? cur.filter((x) => x !== projectId) : [...cur, projectId]));

  return (
    <div className="stack" style={{ gap: 8, padding: '8px 12px 12px', borderLeft: '2px solid var(--border)' }}>
      <label className="row small" style={{ gap: 8 }}>
        <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
        <span>Every project</span>
      </label>

      {!all && (
        <div className="stack" style={{ gap: 4 }}>
          {projects.length === 0 ? (
            <p className="text-dim small">No projects yet.</p>
          ) : (
            projects.map((p) => (
              <label key={p.projectId} className="row small" style={{ gap: 8 }}>
                <input type="checkbox" checked={ids.includes(p.projectId)} onChange={() => toggle(p.projectId)} />
                <span>{p.name ?? p.projectId}</span>
              </label>
            ))
          )}
        </div>
      )}

      <div className="row" style={{ gap: 8 }}>
        <button className="btn btn-primary btn-sm" onClick={() => onSave(ids, all)} disabled={busy}>
          Save access
        </button>
      </div>
    </div>
  );
}
