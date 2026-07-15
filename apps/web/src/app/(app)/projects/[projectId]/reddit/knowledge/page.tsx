'use client';

import { use, useCallback, useEffect, useState } from 'react';
import { Plus, Trash2, ExternalLink } from 'lucide-react';
import PageHeader from '@/components/PageHeader';
import ArrayInput from '@/components/reddit/ArrayInput';
import { apiGet, apiPost, apiFetch, ApiError } from '@/lib/api';

// Knowledge sources.
//
// These are not reference material — they decide whether the tool recommends
// speaking at all. The analysis prompt downgrades toward "skip" when no source
// supports a reply, and relevantSourceIds must be empty for a skip. A project
// with no sources will score almost everything as skip, which is correct
// behaviour and surprises people, so the empty state says so.

interface Source {
  sourceId: string;
  type: 'url' | 'pasted_text';
  title: string;
  url: string | null;
  summary: string;
  keyPoints: string[];
  answerAngles: string[];
  relatedProblems: string[];
}

interface Form {
  type: 'url' | 'pasted_text';
  title: string;
  url: string;
  summary: string;
  keyPoints: string[];
  answerAngles: string[];
  relatedProblems: string[];
}

const EMPTY: Form = {
  type: 'url',
  title: '',
  url: '',
  summary: '',
  keyPoints: [],
  answerAngles: [],
  relatedProblems: [],
};

export default function KnowledgePage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = use(params);
  const [sources, setSources] = useState<Source[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await apiGet<{ sources: Source[] }>(`/api/projects/${projectId}/sources`);
      setSources(r.sources);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load sources.');
      setSources([]);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !form.title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await apiPost(`/api/projects/${projectId}/sources`, form);
      setForm(EMPTY);
      setAdding(false);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add that source.');
    } finally {
      setBusy(false);
    }
  }

  async function remove(sourceId: string) {
    setError(null);
    try {
      await apiFetch(`/api/projects/${projectId}/sources/${sourceId}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete that source.');
    }
  }

  return (
    <>
      <PageHeader
        title="Knowledge"
        description="What this client can credibly speak to. Every analysis is scored against these."
        action={
          !adding ? (
            <button className="btn btn-primary btn-sm" onClick={() => setAdding(true)}>
              <Plus size={14} /> Add source
            </button>
          ) : undefined
        }
      />

      <div className="sections">
        {adding && (
          <section className="card">
            <div className="card-head">
              <h3>New source</h3>
            </div>
            <form className="stack" onSubmit={add}>
              <label className="field">
                <span>Type</span>
                <select
                  value={form.type}
                  onChange={(e) => setForm({ ...form, type: e.target.value as 'url' | 'pasted_text' })}
                >
                  <option value="url">Link</option>
                  <option value="pasted_text">Pasted text</option>
                </select>
              </label>
              <label className="field">
                <span>Title</span>
                <input
                  autoFocus
                  value={form.title}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                  placeholder="How our pricing works"
                  required
                />
              </label>
              {form.type === 'url' && (
                <label className="field">
                  <span>URL</span>
                  <input
                    value={form.url}
                    onChange={(e) => setForm({ ...form, url: e.target.value })}
                    placeholder="https://acme.com/pricing"
                  />
                </label>
              )}
              <label className="field" style={{ maxWidth: 640 }}>
                <span>Summary</span>
                <textarea
                  value={form.summary}
                  onChange={(e) => setForm({ ...form, summary: e.target.value })}
                  placeholder="What this says, in plain language. The model reads this."
                />
              </label>
              <label className="field" style={{ maxWidth: 640 }}>
                <span>Key points</span>
                <ArrayInput
                  value={form.keyPoints}
                  onChange={(v) => setForm({ ...form, keyPoints: v })}
                  placeholder="Add a point and press Enter"
                />
              </label>
              <label className="field" style={{ maxWidth: 640 }}>
                <span>Answer angles</span>
                <ArrayInput
                  value={form.answerAngles}
                  onChange={(v) => setForm({ ...form, answerAngles: v })}
                  placeholder="Ways this can genuinely help someone"
                />
              </label>
              <label className="field" style={{ maxWidth: 640 }}>
                <span>Related problems</span>
                <ArrayInput
                  value={form.relatedProblems}
                  onChange={(v) => setForm({ ...form, relatedProblems: v })}
                  placeholder="Problems this speaks to"
                />
              </label>
              <div className="row">
                <button className="btn btn-primary btn-sm" type="submit" disabled={busy || !form.title.trim()}>
                  {busy ? 'Adding…' : 'Add source'}
                </button>
                <button className="btn btn-ghost btn-sm" type="button" onClick={() => setAdding(false)}>
                  Cancel
                </button>
              </div>
            </form>
          </section>
        )}

        {error && <p className="text-error small">{error}</p>}

        {sources === null && <p className="text-dim small">Loading…</p>}

        {sources?.length === 0 && !adding && (
          <div className="card">
            <div className="empty">
              <p>No knowledge sources yet.</p>
              <p className="text-dim small">
                Without these, the model has nothing to judge relevance against and will score almost
                every post as skip. That&apos;s correct — it just means the tool has nothing to say yet.
              </p>
            </div>
          </div>
        )}

        {sources && sources.length > 0 && (
          <section className="card">
            <ul className="list">
              {sources.map((s) => (
                <li key={s.sourceId} className="list-row">
                  <div style={{ minWidth: 0 }}>
                    <strong>{s.title}</strong>
                    {s.url && (
                      <div className="text-dim small">
                        <a href={s.url} target="_blank" rel="noreferrer">
                          {s.url} <ExternalLink size={10} />
                        </a>
                      </div>
                    )}
                    {s.summary && <div className="text-muted small clamp">{s.summary}</div>}
                    <div className="text-faint small">
                      {s.keyPoints.length} points · {s.answerAngles.length} angles ·{' '}
                      {s.relatedProblems.length} problems
                    </div>
                  </div>
                  <button
                    className="btn btn-danger btn-sm btn-icon"
                    onClick={() => remove(s.sourceId)}
                    aria-label={`Delete ${s.title}`}
                  >
                    <Trash2 size={14} />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </>
  );
}
