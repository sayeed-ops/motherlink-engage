'use client';

import { use, useEffect, useState } from 'react';
import PageHeader from '@/components/PageHeader';
import ArrayInput from '@/components/reddit/ArrayInput';
import { apiGet, apiFetch, ApiError } from '@/lib/api';
import type { RedditModuleConfig } from '@/lib/types';

const EMPTY: RedditModuleConfig = {
  companyDescription: '',
  targetCustomer: '',
  productService: '',
  targetSubreddits: [],
  keywords: [],
  brandMentionStyle: '',
  forbiddenPhrases: [],
};

export default function RedditSettingsPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = use(params);
  const [config, setConfig] = useState<RedditModuleConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    apiGet<{ config: RedditModuleConfig }>(`/api/projects/${projectId}/reddit/config`)
      .then((r) => setConfig(r.config))
      .catch(() => setConfig(EMPTY));
  }, [projectId]);

  const set = <K extends keyof RedditModuleConfig>(k: K, v: RedditModuleConfig[K]) => {
    setConfig((c) => (c ? { ...c, [k]: v } : c));
    setSaved(false);
  };

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!config || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await apiFetch<{ config: RedditModuleConfig }>(`/api/projects/${projectId}/reddit/config`, {
        method: 'PUT',
        body: JSON.stringify(config),
      });
      setConfig(r.config);
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  }

  if (!config) return <p className="text-dim small">Loading…</p>;

  return (
    <>
      <PageHeader
        title="Reddit settings"
        description="What this client does, where to look, and how the brand may be mentioned."
      />

      <form className="sections" onSubmit={save}>
        <section className="card">
          <div className="card-head">
            <h3>The client</h3>
          </div>
          <div className="stack">
            <label className="field" style={{ maxWidth: 640 }}>
              <span>What they do</span>
              <textarea
                value={config.companyDescription}
                onChange={(e) => set('companyDescription', e.target.value)}
                placeholder="One or two sentences a stranger would understand."
              />
            </label>
            <label className="field" style={{ maxWidth: 640 }}>
              <span>Who it&apos;s for</span>
              <textarea
                value={config.targetCustomer}
                onChange={(e) => set('targetCustomer', e.target.value)}
                placeholder="The person with the problem."
              />
            </label>
            <label className="field" style={{ maxWidth: 640 }}>
              <span>Product or service</span>
              <textarea
                value={config.productService}
                onChange={(e) => set('productService', e.target.value)}
                placeholder="What they actually sell."
              />
            </label>
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <h3>Where to look</h3>
          </div>
          <div className="stack">
            <label className="field" style={{ maxWidth: 640 }}>
              <span>Subreddits</span>
              <ArrayInput
                value={config.targetSubreddits}
                onChange={(v) => set('targetSubreddits', v)}
                placeholder="budget, personalfinance…"
              />
              <span className="text-dim small">
                r/ prefixes are stripped automatically. Max 20 per fetch.
              </span>
            </label>
            <label className="field" style={{ maxWidth: 640 }}>
              <span>Keywords</span>
              <ArrayInput
                value={config.keywords}
                onChange={(v) => set('keywords', v)}
                placeholder="budgeting app, track spending…"
              />
              <span className="text-dim small">
                Used for search. Multi-word phrases are quoted and OR&apos;d together. Max 15.
              </span>
            </label>
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <h3>Tone and limits</h3>
          </div>
          <div className="stack">
            <label className="field" style={{ maxWidth: 640 }}>
              <span>Brand mention style</span>
              <textarea
                value={config.brandMentionStyle}
                onChange={(e) => set('brandMentionStyle', e.target.value)}
                placeholder="When, and how, the brand may come up at all."
              />
            </label>
            <label className="field" style={{ maxWidth: 640 }}>
              <span>Forbidden phrases</span>
              <ArrayInput
                value={config.forbiddenPhrases}
                onChange={(v) => set('forbiddenPhrases', v)}
                placeholder="game changer, revolutionary…"
              />
              <span className="text-dim small">
                Claims and hype the client must never make. Passed to the model as hard constraints.
              </span>
            </label>
          </div>
        </section>

        {error && <p className="text-error small">{error}</p>}
        {saved && <p className="text-success small">Saved.</p>}

        <div className="row">
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Save settings'}
          </button>
        </div>
      </form>
    </>
  );
}
