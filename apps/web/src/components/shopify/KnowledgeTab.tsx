'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Check, Copy, ExternalLink, FileJson2, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import ArrayInput from '@/components/reddit/ArrayInput';
import { apiFetch, apiGet, apiPost, ApiError } from '@/lib/api';
import { ORIGIN_LABEL, type ShopifySource, type SourceInput } from '@/modules/shopify/knowledge';
import { buildShopifySourcesPrompt } from '@/modules/shopify/importPrompts';
import type { ShopifyClientProfile } from '@/modules/shopify/client';
import { age } from './types';

/**
 * Shopify's own knowledge — filled by hand, by pasted JSON, or copied from
 * Reddit.
 *
 * ⚠️ COPY FROM REDDIT ONLY ADDS. The client profile's copy replaces, because it
 * is one record; this is a list, and replacing it would delete every source
 * added here for Shopify alone. A source already held — copied before (even if
 * edited since), or with the same URL or title — is left as it is.
 */

const EMPTY: SourceInput = {
  type: 'url',
  title: '',
  url: '',
  summary: '',
  keyPoints: [],
  answerAngles: [],
  relatedProblems: [],
};

interface ImportResult {
  created: number;
  duplicates: string[];
  rejected: { index: number; reason: string }[];
}

export default function KnowledgeTab({
  projectId,
  client,
  onSources,
}: {
  projectId: string;
  client: ShopifyClientProfile;
  /** The page keeps the list too — it names the sources a Brand score or a
   *  draft relied on. Must be stable (a state setter), or this reloads forever. */
  onSources: (s: ShopifySource[]) => void;
}) {
  const [sources, setSources] = useState<ShopifySource[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // One form for add and edit: `editing` is the id being edited, or 'new'.
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<SourceInput>(EMPTY);

  const [importOpen, setImportOpen] = useState(false);
  const [importJson, setImportJson] = useState('');
  const [copied, setCopied] = useState(false);
  const [project, setProject] = useState<{ name: string; websiteUrl: string }>({ name: '', websiteUrl: '' });

  const load = useCallback(async () => {
    try {
      const r = await apiGet<{ sources: ShopifySource[] }>(`/api/projects/${projectId}/shopify/knowledge`);
      setSources(r.sources);
      onSources(r.sources);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The knowledge list could not be loaded.');
      setSources([]);
    }
  }, [projectId, onSources]);

  useEffect(() => {
    void load();
  }, [load]);

  // The project's name and site, for the copied prompt. Best effort — the
  // prompt still works with blanks.
  useEffect(() => {
    apiGet<{ projects: { projectId: string; name: string; clientWebsiteUrl: string }[] }>('/api/projects')
      .then((r) => {
        const p = r.projects.find((x) => x.projectId === projectId);
        if (p) setProject({ name: p.name, websiteUrl: p.clientWebsiteUrl ?? '' });
      })
      .catch(() => {});
  }, [projectId]);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    setNote(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That did not work.');
    } finally {
      setBusy(null);
    }
  };

  const copyFromReddit = () =>
    run('sync', async () => {
      const r = await apiPost<{ added: number; alreadyHeld: number; unusable: number; redditTotal: number }>(
        `/api/projects/${projectId}/shopify/knowledge/sync`,
        {},
      );
      setNote(
        r.redditTotal === 0
          ? 'Reddit has no knowledge sources on this project to copy.'
          : `Copied ${r.added} from Reddit. ${r.alreadyHeld} already held here — left as they are.` +
              (r.unusable ? ` ${r.unusable} had no title and were skipped.` : ''),
      );
      await load();
    });

  const importNow = () =>
    run('import', async () => {
      const r = await apiPost<ImportResult>(`/api/projects/${projectId}/shopify/knowledge`, { json: importJson });
      const parts = [`Imported ${r.created} source${r.created === 1 ? '' : 's'}.`];
      if (r.duplicates.length) parts.push(`${r.duplicates.length} already held, skipped: ${r.duplicates.join('; ')}.`);
      if (r.rejected.length) {
        parts.push(`${r.rejected.length} unusable: ${r.rejected.map((x) => `row ${x.index + 1} (${x.reason})`).join(', ')}.`);
      }
      setNote(parts.join(' '));
      setImportJson('');
      setImportOpen(false);
      await load();
    });

  const saveForm = () =>
    run('form', async () => {
      const source = { ...form, url: form.type === 'url' ? form.url : null };
      if (editing === 'new') {
        await apiPost(`/api/projects/${projectId}/shopify/knowledge`, { source });
      } else if (editing) {
        await apiFetch(`/api/projects/${projectId}/shopify/knowledge/${editing}`, {
          method: 'PUT',
          body: JSON.stringify({ source }),
        });
      }
      setEditing(null);
      setForm(EMPTY);
      await load();
    });

  const remove = (s: ShopifySource) => {
    if (!window.confirm(`Delete "${s.title}"? Drafts that used it keep their text.`)) return;
    void run(`del:${s.sourceId}`, async () => {
      await apiFetch(`/api/projects/${projectId}/shopify/knowledge/${s.sourceId}`, { method: 'DELETE' });
      await load();
    });
  };

  const copyPrompt = async () => {
    await navigator.clipboard.writeText(
      buildShopifySourcesPrompt({
        name: project.name,
        websiteUrl: project.websiteUrl,
        companyDescription: client.companyDescription,
        targetCustomer: client.targetCustomer,
        productService: client.productService,
        brandMentionStyle: client.brandMentionStyle,
        forbiddenPhrases: client.forbiddenPhrases,
      }),
    );
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="sections">
      <section className="card">
        <div className="card-head">
          <h3>Knowledge</h3>
          <div className="row" style={{ flexWrap: 'wrap', gap: '0.4rem' }}>
            <button className="btn btn-secondary btn-sm" onClick={() => void copyFromReddit()} disabled={!!busy}>
              <RefreshCw size={13} /> {busy === 'sync' ? 'Copying…' : 'Copy from Reddit'}
            </button>
            <button className="btn btn-secondary btn-sm" onClick={() => setImportOpen((o) => !o)} disabled={!!busy}>
              <FileJson2 size={13} /> Import JSON
            </button>
            <button
              className="btn btn-primary btn-sm"
              onClick={() => {
                setEditing('new');
                setForm(EMPTY);
              }}
              disabled={!!busy || editing !== null}
            >
              <Plus size={13} /> Add source
            </button>
          </div>
        </div>
        <p className="text-dim small">
          What this client can credibly speak to <strong>on the Shopify community</strong> — its own list, separate from
          Reddit&apos;s. The analysis matches these against each question by the words in the title, key points and
          answer angles; a reply may only name the client where one of them supports it. <strong>Copy from Reddit</strong>{' '}
          adds what is missing and never replaces or deletes anything here.
        </p>
        {note && <div className="alert alert-info">{note}</div>}
        {error && (
          <div className="alert alert-error">
            <AlertTriangle size={15} aria-hidden /> {error}
          </div>
        )}
      </section>

      {importOpen && (
        <section className="card">
          <div className="card-head">
            <h3>
              <FileJson2 size={15} style={{ verticalAlign: '-2px', marginRight: 6 }} />
              Import sources from JSON
            </h3>
          </div>
          <div className="stack">
            <p className="text-dim small">
              Paste a JSON array of sources (or one object). The copied prompt carries{' '}
              {project.name ? `${project.name}'s` : "this client's"} details from the Client details tab, and asks for
              pages a merchant would actually thank you for. Sources already held — same URL or title — are skipped.
            </p>
            <div className="row">
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => void copyPrompt()}>
                {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? 'Copied' : 'Copy AI prompt'}
              </button>
            </div>
            <label className="field" style={{ maxWidth: 640 }}>
              <span>Paste the JSON the model returned</span>
              <textarea
                value={importJson}
                onChange={(e) => setImportJson(e.target.value)}
                placeholder='[ { "type": "url", "title": "…", "url": "https://…", "summary": "…", "keyPoints": [], "answerAngles": [], "relatedProblems": [] } ]'
                rows={7}
              />
            </label>
            <div className="row">
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => void importNow()}
                disabled={!!busy || !importJson.trim()}
              >
                {busy === 'import' ? 'Importing…' : 'Import'}
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setImportOpen(false)}>
                Cancel
              </button>
            </div>
          </div>
        </section>
      )}

      {editing !== null && (
        <section className="card">
          <div className="card-head">
            <h3>{editing === 'new' ? 'New source' : 'Edit source'}</h3>
          </div>
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              void saveForm();
            }}
          >
            <label className="field">
              <span>Type</span>
              <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as SourceInput['type'] })}>
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
                placeholder="How to fix duplicate product pages"
                required
              />
            </label>
            {form.type === 'url' && (
              <label className="field">
                <span>URL</span>
                <input
                  value={form.url ?? ''}
                  onChange={(e) => setForm({ ...form, url: e.target.value })}
                  placeholder="https://northwind.example/guides/duplicates"
                />
              </label>
            )}
            <label className="field" style={{ maxWidth: 640 }}>
              <span>Summary</span>
              <textarea
                value={form.summary}
                onChange={(e) => setForm({ ...form, summary: e.target.value })}
                placeholder="What the page says, plainly. The model reads this."
              />
            </label>
            <label className="field" style={{ maxWidth: 640 }}>
              <span>Key points</span>
              <ArrayInput value={form.keyPoints} onChange={(v) => setForm({ ...form, keyPoints: v })} placeholder="A fact the page supports — Enter to add" />
            </label>
            <label className="field" style={{ maxWidth: 640 }}>
              <span>Answer angles</span>
              <ArrayInput
                value={form.answerAngles}
                onChange={(v) => setForm({ ...form, answerAngles: v })}
                placeholder="A kind of merchant question this answers"
              />
            </label>
            <label className="field" style={{ maxWidth: 640 }}>
              <span>Related problems</span>
              <ArrayInput
                value={form.relatedProblems}
                onChange={(v) => setForm({ ...form, relatedProblems: v })}
                placeholder="How a merchant would describe the pain"
              />
            </label>
            <div className="row">
              <button className="btn btn-primary btn-sm" type="submit" disabled={!!busy || !form.title.trim()}>
                {busy === 'form' ? 'Saving…' : editing === 'new' ? 'Add source' : 'Save changes'}
              </button>
              <button className="btn btn-ghost btn-sm" type="button" onClick={() => setEditing(null)}>
                Cancel
              </button>
            </div>
          </form>
        </section>
      )}

      {sources === null && <p className="text-dim small">Loading…</p>}

      {sources?.length === 0 && editing === null && (
        <div className="card">
          <div className="empty">
            <p>No knowledge sources for Shopify yet.</p>
            <p className="text-dim small">
              Without one, Brand is capped low in every analysis and cannot be drafted — a reply may not name the client
              on no evidence. Open and Growth work regardless. Copy Reddit&apos;s, import JSON, or add one by hand.
            </p>
          </div>
        </div>
      )}

      {sources && sources.length > 0 && (
        <section className="card">
          <div className="card-head">
            <h3>Sources</h3>
            <span className="badge">{sources.length}</span>
          </div>
          <ul className="list">
            {sources.map((s) => (
              <li key={s.sourceId} className="list-row">
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="row" style={{ gap: '0.4rem', flexWrap: 'wrap' }}>
                    <strong>{s.title}</strong>
                    <span className="badge">{ORIGIN_LABEL[s.origin]}</span>
                    {s.editedAtMs !== null && s.origin !== 'manual' && (
                      <span className="small text-dim">edited here {age(s.editedAtMs)}</span>
                    )}
                  </div>
                  {s.url && (
                    <div className="text-dim small">
                      <a href={s.url} target="_blank" rel="noreferrer">
                        {s.url} <ExternalLink size={10} />
                      </a>
                    </div>
                  )}
                  {s.summary && <div className="text-muted small clamp">{s.summary}</div>}
                  <div className="text-faint small">
                    {s.keyPoints.length} points · {s.answerAngles.length} angles · {s.relatedProblems.length} problems
                  </div>
                </div>
                <div className="row" style={{ gap: '0.3rem', flexShrink: 0 }}>
                  <button
                    className="btn btn-ghost btn-sm btn-icon"
                    onClick={() => {
                      setEditing(s.sourceId);
                      setForm({
                        type: s.type,
                        title: s.title,
                        url: s.url ?? '',
                        summary: s.summary,
                        keyPoints: s.keyPoints,
                        answerAngles: s.answerAngles,
                        relatedProblems: s.relatedProblems,
                      });
                    }}
                    disabled={!!busy}
                    aria-label={`Edit ${s.title}`}
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    className="btn btn-danger btn-sm btn-icon"
                    onClick={() => remove(s)}
                    disabled={!!busy}
                    aria-label={`Delete ${s.title}`}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
