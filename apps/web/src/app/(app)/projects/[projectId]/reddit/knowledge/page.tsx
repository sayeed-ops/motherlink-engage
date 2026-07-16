'use client';

import { use, useCallback, useEffect, useState } from 'react';
import { Plus, Trash2, ExternalLink, FileJson2, Copy, Check } from 'lucide-react';
import PageHeader from '@/components/PageHeader';
import ArrayInput from '@/components/reddit/ArrayInput';
import { apiGet, apiPost, apiFetch, ApiError } from '@/lib/api';
import { buildSourcesImportPrompt, type SourcesPromptContext } from '@/modules/reddit/import-prompts';

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

  // Bulk import + copy-prompt. promptCtx carries the company context the sources
  // prompt bakes in, so the model grounds its suggestions in this client.
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkJson, setBulkJson] = useState('');
  const [bulkErr, setBulkErr] = useState<string | null>(null);
  const [bulkResult, setBulkResult] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [copiedPrompt, setCopiedPrompt] = useState(false);
  const [promptCtx, setPromptCtx] = useState<SourcesPromptContext | null>(null);

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

  // Company context for the "Copy AI prompt" button — best effort; the prompt
  // still works with blanks if this fails.
  useEffect(() => {
    (async () => {
      try {
        const [cfg, list] = await Promise.all([
          apiGet<{ config: Record<string, unknown> }>(`/api/projects/${projectId}/reddit/config`),
          apiGet<{ projects: { projectId: string; name: string; clientWebsiteUrl: string }[] }>('/api/projects'),
        ]);
        const proj = list.projects.find((p) => p.projectId === projectId);
        const c = cfg.config ?? {};
        setPromptCtx({
          name: proj?.name ?? '',
          websiteUrl: proj?.clientWebsiteUrl ?? '',
          companyDescription: String(c.companyDescription ?? ''),
          targetCustomer: String(c.targetCustomer ?? ''),
          productService: String(c.productService ?? ''),
          brandMentionStyle: String(c.brandMentionStyle ?? ''),
          forbiddenPhrases: Array.isArray(c.forbiddenPhrases) ? (c.forbiddenPhrases as string[]) : [],
        });
      } catch {
        // Leave promptCtx null; copyPrompt falls back to a blank context.
      }
    })();
  }, [projectId]);

  async function copyPrompt() {
    const ctx: SourcesPromptContext = promptCtx ?? {
      name: '',
      websiteUrl: '',
      companyDescription: '',
      targetCustomer: '',
      productService: '',
      brandMentionStyle: '',
      forbiddenPhrases: [],
    };
    await navigator.clipboard.writeText(buildSourcesImportPrompt(ctx));
    setCopiedPrompt(true);
    setTimeout(() => setCopiedPrompt(false), 1600);
  }

  async function bulkImport() {
    setBulkErr(null);
    setBulkResult(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(bulkJson);
    } catch {
      setBulkErr('That is not valid JSON.');
      return;
    }
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    const valid = rows.filter(
      (r): r is Record<string, unknown> =>
        !!r &&
        typeof r === 'object' &&
        !Array.isArray(r) &&
        typeof (r as Record<string, unknown>).title === 'string' &&
        (r as Record<string, unknown>).title!.toString().trim().length > 0,
    );
    if (valid.length === 0) {
      setBulkErr('No usable rows: each source needs at least a non-empty "title".');
      return;
    }

    setBulkBusy(true);
    let created = 0;
    let failed = 0;
    const arr = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
    for (const row of valid) {
      try {
        await apiPost(`/api/projects/${projectId}/sources`, {
          type: row.type === 'pasted_text' ? 'pasted_text' : 'url',
          title: String(row.title).trim(),
          url: typeof row.url === 'string' ? row.url : '',
          summary: typeof row.summary === 'string' ? row.summary : '',
          keyPoints: arr(row.keyPoints),
          answerAngles: arr(row.answerAngles),
          relatedProblems: arr(row.relatedProblems),
        });
        created++;
      } catch {
        failed++;
      }
    }
    setBulkBusy(false);
    setBulkResult(`Imported ${created} source${created === 1 ? '' : 's'}${failed ? `, ${failed} failed` : ''}.`);
    setBulkJson('');
    setBulkOpen(false);
    await load();
  }

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
            <div className="row">
              <button className="btn btn-secondary btn-sm" onClick={() => setBulkOpen((o) => !o)}>
                <FileJson2 size={14} /> Bulk import
              </button>
              <button className="btn btn-primary btn-sm" onClick={() => setAdding(true)}>
                <Plus size={14} /> Add source
              </button>
            </div>
          ) : undefined
        }
      />

      <div className="sections">
        {bulkOpen && (
          <section className="card">
            <div className="card-head">
              <h3>
                <FileJson2 size={15} style={{ verticalAlign: '-2px', marginRight: 6 }} />
                Bulk import sources
              </h3>
            </div>
            <div className="stack">
              <p className="text-dim small">
                Paste a JSON array of sources (or a single object). Copy the ready-made prompt below —
                it bakes in {promptCtx?.name ? `${promptCtx.name}'s` : "this client's"} context so the
                model suggests genuinely useful, Reddit-native sources.
              </p>
              <div className="row">
                <button type="button" className="btn btn-secondary btn-sm" onClick={copyPrompt}>
                  {copiedPrompt ? <Check size={13} /> : <Copy size={13} />}{' '}
                  {copiedPrompt ? 'Copied' : 'Copy AI prompt'}
                </button>
              </div>
              <label className="field" style={{ maxWidth: 640 }}>
                <span>Paste the JSON the model returned</span>
                <textarea
                  value={bulkJson}
                  onChange={(e) => setBulkJson(e.target.value)}
                  placeholder='[ { "type": "url", "title": "Pricing", "url": "https://…", "summary": "…", "keyPoints": [], "answerAngles": [], "relatedProblems": [] } ]'
                  rows={6}
                />
              </label>
              {bulkErr && <p className="text-error small">{bulkErr}</p>}
              <div className="row">
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={bulkImport}
                  disabled={bulkBusy || !bulkJson.trim()}
                >
                  {bulkBusy ? 'Importing…' : 'Import'}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => {
                    setBulkJson('');
                    setBulkErr(null);
                  }}
                >
                  Clear
                </button>
              </div>
            </div>
          </section>
        )}

        {bulkResult && <p className="text-success small">{bulkResult}</p>}

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
