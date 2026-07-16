'use client';

import { use, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw, Sparkles, PenLine, Copy, ExternalLink, Search, Square } from 'lucide-react';
import PageHeader from '@/components/PageHeader';
import { apiPost, ApiError } from '@/lib/api';
import { subscribe, subscribeDoc, q, path } from '@/lib/data';
import type { RedditModuleConfig } from '@/lib/types';

// The review queue: fetch, analyse, draft, read.
//
// Thresholds and filter names are ported from ML Studio so the same posts land
// in the same buckets — parity is judged on this screen.

const GROWTH_MIN = 40;
const QUALITY_FLOOR: Record<string, number> = { any: 0, best: 75, good: 60, okay: 40 };

// 0.8-1.5s jittered gap between subreddits. Reddit rate-limits per IP, and a
// regular cadence looks more like a script than a person.
const RSS_GAP_MIN_MS = 800;
const RSS_GAP_JITTER_MS = 700;

interface Draft {
  draftId: string;
  body: string;
  status: string;
  promptVersion: string;
}

interface Analysis {
  analysisId: string;
  decision: 'reply' | 'maybe' | 'skip';
  score: number;
  reason: string;
  riskLevel: 'low' | 'medium' | 'high';
  mentionRecommendation: 'yes' | 'soft' | 'no';
  suggestedAngle: string;
  growthScore: number | null;
  growthAngle: string;
  promptVersion: string;
}

interface Item {
  itemId: string;
  externalId: string;
  subreddit: string;
  title: string;
  body: string;
  author: string;
  permalink: string;
  createdAtSource: string | null;
  processingStatus: string;
  isFavorite: boolean;
  analysis: Analysis | null;
  drafts: Draft[];
}

type Filter = 'brand' | 'growth' | 'unanalyzed' | 'all';

const age = (iso: string | null) => {
  if (!iso) return '';
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 60) return `${m}m ago`;
  if (m < 1440) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
};

const isBrand = (a: Analysis) =>
  a.decision !== 'skip' && (a.mentionRecommendation === 'yes' || a.mentionRecommendation === 'soft');
const isGrowth = (a: Analysis) => a.mentionRecommendation === 'no' && (a.growthScore ?? 0) >= GROWTH_MIN;

export default function OpportunitiesPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = use(params);

  // Reads come straight from Firestore, live. No server round-trip, local
  // cache, and the list updates in real time as fetch/analyze/draft write —
  // so a running Analyse loop fills the screen as it goes, with no polling.
  const [rawItems, setRawItems] = useState<Record<string, unknown>[] | null>(null);
  const [rawAnalyses, setRawAnalyses] = useState<Record<string, unknown>[]>([]);
  const [rawDrafts, setRawDrafts] = useState<Record<string, unknown>[]>([]);
  const [config, setConfig] = useState<RedditModuleConfig | null>(null);

  const [filter, setFilter] = useState<Filter>('brand');
  const [floor, setFloor] = useState<keyof typeof QUALITY_FLOOR>('any');
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  // Cooperative stop flag. Long loops must be interruptible and must keep the
  // work already done — ML Studio does the same, and it matters: a fetch across
  // 15 subreddits is slow, and throwing away 12 successes because someone
  // clicked stop would be worse than not offering stop at all.
  const stop = useRef(false);

  useEffect(() => {
    const onErr = (e: Error) => setError(e.message);
    const unsub = [
      subscribe<Record<string, unknown>>(q.items(projectId), setRawItems, onErr),
      subscribe<Record<string, unknown>>(q.analyses(projectId), setRawAnalyses, onErr),
      subscribe<Record<string, unknown>>(q.drafts(projectId), setRawDrafts, onErr),
      subscribeDoc<RedditModuleConfig>(path.redditConfig(projectId), (c) => setConfig(c ?? null), onErr),
    ];
    return () => unsub.forEach((u) => u());
  }, [projectId]);

  const ms = (v: unknown): number =>
    v && typeof v === 'object' && 'toMillis' in v ? (v as { toMillis(): number }).toMillis() : 0;
  const isoOf = (v: unknown): string | null =>
    v && typeof v === 'object' && 'toDate' in v ? (v as { toDate(): Date }).toDate().toISOString() : null;

  // Join items + latest analysis + drafts, exactly as the server route did,
  // but derived from the live subscriptions.
  const items = useMemo<Item[] | null>(() => {
    if (rawItems === null) return null;

    const latest = new Map<string, Record<string, unknown>>();
    for (const a of rawAnalyses) {
      const key = a.itemId as string;
      const prev = latest.get(key);
      if (!prev || ms(a.createdAt) > ms(prev.createdAt)) latest.set(key, a);
    }

    const byItem = new Map<string, Record<string, unknown>[]>();
    for (const d of rawDrafts) {
      const key = d.itemId as string;
      (byItem.get(key) ?? byItem.set(key, []).get(key)!).push(d);
    }

    return rawItems
      .map((i) => {
        const id = i.id as string;
        const a = latest.get(id);
        return {
          itemId: id,
          externalId: i.externalId as string,
          subreddit: i.subreddit as string,
          title: i.title as string,
          body: i.body as string,
          author: i.author as string,
          permalink: i.permalink as string,
          createdAtSource: isoOf(i.createdAtSource),
          processingStatus: i.processingStatus as string,
          isFavorite: Boolean(i.isFavorite),
          analysis: a
            ? {
                analysisId: a.analysisId as string,
                decision: a.decision as Analysis['decision'],
                score: a.score as number,
                reason: a.reason as string,
                riskLevel: a.riskLevel as Analysis['riskLevel'],
                mentionRecommendation: a.mentionRecommendation as Analysis['mentionRecommendation'],
                suggestedAngle: a.suggestedAngle as string,
                growthScore: (a.growthScore as number | null) ?? null,
                growthAngle: (a.growthAngle as string) ?? '',
                promptVersion: a.promptVersion as string,
              }
            : null,
          drafts: (byItem.get(id) ?? []).map((d) => ({
            draftId: d.draftId as string,
            body: d.body as string,
            status: d.status as string,
            promptVersion: d.promptVersion as string,
          })),
        } satisfies Item;
      })
      .sort((a, b) => (b.createdAtSource ?? '').localeCompare(a.createdAtSource ?? ''));
  }, [rawItems, rawAnalyses, rawDrafts]);

  async function runFetch(mode: 'new' | 'search') {
    if (!config?.targetSubreddits.length) {
      setError('Add at least one subreddit in Settings first.');
      return;
    }
    if (mode === 'search' && !config.keywords.length) {
      setError('Search needs keywords. Add some in Settings.');
      return;
    }

    stop.current = false;
    setError(null);
    setBusy(mode === 'search' ? 'search' : 'fetch');

    let created = 0;
    const subs = config.targetSubreddits;

    // One subreddit per request, jittered. The server throttles internally too,
    // but pacing here keeps the UI honest about progress and lets stop work.
    for (let i = 0; i < subs.length; i++) {
      if (stop.current) break;
      setProgress(`r/${subs[i]} (${i + 1}/${subs.length})`);
      try {
        const r = await apiPost<{ saved: { created: number }; errors: { message: string }[] }>(
          `/api/projects/${projectId}/reddit/fetch`,
          { mode, subreddits: [subs[i]], keywords: config.keywords, limit: 25 },
        );
        created += r.saved?.created ?? 0;
        if (r.errors?.length) setError(`r/${subs[i]}: ${r.errors[0].message}`);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Fetch failed.');
        break;
      }
      if (i < subs.length - 1 && !stop.current) {
        await new Promise((r) => setTimeout(r, RSS_GAP_MIN_MS + Math.random() * RSS_GAP_JITTER_MS));
      }
    }

    setProgress(null);
    setBusy(null);
    // No reload: the items subscription reflects the new posts as they land.
    if (!error) setProgress(`${created} new post${created === 1 ? '' : 's'}.`);
  }

  async function analyzeAll() {
    const todo = (items ?? []).filter((i) => !i.analysis);
    if (!todo.length) return;

    stop.current = false;
    setBusy('analyze');
    setError(null);

    for (let i = 0; i < todo.length; i++) {
      if (stop.current) break;
      setProgress(`${i + 1}/${todo.length}`);
      try {
        await apiPost(`/api/projects/${projectId}/reddit/analyze`, { itemId: todo[i].itemId });
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Analysis failed.');
        break;
      }
    }

    setProgress(null);
    setBusy(null);
    // Analyses stream in live as the loop runs — no reload needed.
  }

  async function draft(item: Item) {
    if (!item.analysis) return;
    setBusy(item.itemId);
    setError(null);
    try {
      await apiPost(`/api/projects/${projectId}/reddit/draft`, {
        itemId: item.itemId,
        analysisId: item.analysis.analysisId,
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not draft a reply.');
    } finally {
      setBusy(null);
    }
  }

  async function copy(draft: Draft) {
    await navigator.clipboard.writeText(draft.body);
    setCopied(draft.draftId);
    setTimeout(() => setCopied(null), 1600);
  }

  const shown = useMemo(() => {
    const min = QUALITY_FLOOR[floor];
    return (items ?? []).filter((i) => {
      if (filter === 'unanalyzed') return !i.analysis;
      if (!i.analysis) return false;
      if (filter === 'brand') return isBrand(i.analysis) && i.analysis.score >= min;
      if (filter === 'growth') return isGrowth(i.analysis) && (i.analysis.growthScore ?? 0) >= min;
      return true;
    });
  }, [items, filter, floor]);

  const counts = useMemo(() => {
    const all = items ?? [];
    return {
      brand: all.filter((i) => i.analysis && isBrand(i.analysis)).length,
      growth: all.filter((i) => i.analysis && isGrowth(i.analysis)).length,
      unanalyzed: all.filter((i) => !i.analysis).length,
      all: all.length,
    };
  }, [items]);

  const running = busy === 'fetch' || busy === 'search' || busy === 'analyze';

  return (
    <>
      <PageHeader
        title="Opportunities"
        description="Fetch conversations, score them against the knowledge base, draft a reply."
        action={
          <div className="row">
            {running ? (
              <button className="btn btn-danger btn-sm" onClick={() => (stop.current = true)}>
                <Square size={13} /> Stop
              </button>
            ) : (
              <>
                <button className="btn btn-secondary btn-sm" onClick={() => runFetch('new')} disabled={!!busy}>
                  <RefreshCw size={14} /> Fetch new
                </button>
                <button className="btn btn-secondary btn-sm" onClick={() => runFetch('search')} disabled={!!busy}>
                  <Search size={14} /> Search
                </button>
                <button
                  className="btn btn-primary btn-sm"
                  onClick={analyzeAll}
                  disabled={!!busy || counts.unanalyzed === 0}
                >
                  <Sparkles size={14} /> Analyse {counts.unanalyzed || ''}
                </button>
              </>
            )}
          </div>
        }
      />

      <div className="sections">
        {(progress || error) && (
          <p className={error ? 'text-error small' : 'text-muted small'}>{error ?? progress}</p>
        )}

        <div className="row between">
          <div className="tabs-inline">
            {(['brand', 'growth', 'unanalyzed', 'all'] as Filter[]).map((f) => (
              <button
                key={f}
                className={`chip-tab ${filter === f ? 'active' : ''}`}
                onClick={() => setFilter(f)}
              >
                {f === 'unanalyzed' ? 'Not analysed' : f[0].toUpperCase() + f.slice(1)}
                <span className="chip-count">{counts[f]}</span>
              </button>
            ))}
          </div>
          {filter !== 'unanalyzed' && filter !== 'all' && (
            <select value={floor} onChange={(e) => setFloor(e.target.value as keyof typeof QUALITY_FLOOR)}>
              <option value="any">Any score</option>
              <option value="okay">40+ okay</option>
              <option value="good">60+ good</option>
              <option value="best">75+ best</option>
            </select>
          )}
        </div>

        {items === null && <p className="text-dim small">Loading…</p>}

        {items && shown.length === 0 && (
          <div className="card">
            <div className="empty">
              <p>Nothing here yet.</p>
              <p className="text-dim small">
                {counts.all === 0
                  ? 'Fetch some posts to get started.'
                  : filter === 'brand'
                    ? 'No brand opportunities at this score. Try Growth, or lower the floor.'
                    : 'Nothing matches this filter.'}
              </p>
            </div>
          </div>
        )}

        {shown.map((item) => {
          const a = item.analysis;
          const kind = a ? (isBrand(a) ? 'brand' : isGrowth(a) ? 'growth' : null) : null;

          return (
            <article key={item.itemId} className="card">
              <div className="card-head">
                <div className="row">
                  <span className="badge badge-no-dot badge-solid">{`r/${item.subreddit}`}</span>
                  <span className="text-dim small">{age(item.createdAtSource)}</span>
                  <span className="text-faint small">u/{item.author}</span>
                </div>
                <div className="row">
                  {a && (
                    <span
                      className={`badge ${
                        a.decision === 'reply' ? 'badge-success' : a.decision === 'maybe' ? 'badge-warning' : ''
                      }`}
                    >
                      {a.decision} {a.score}
                    </span>
                  )}
                  {kind === 'growth' && <span className="badge badge-info">growth {a?.growthScore}</span>}
                  {a && a.riskLevel !== 'low' && (
                    <span className="badge badge-warning">{a.riskLevel} risk</span>
                  )}
                </div>
              </div>

              <h4>
                <a href={item.permalink} target="_blank" rel="noreferrer" className="strong-link">
                  {item.title} <ExternalLink size={12} />
                </a>
              </h4>

              {item.body && <p className="text-muted small clamp">{item.body}</p>}

              {a && (
                <div className="analysis">
                  <p className="text-muted small">{a.reason}</p>
                  {(kind === 'growth' ? a.growthAngle : a.suggestedAngle) && (
                    <p className="small">
                      <span className="eyebrow-muted">Angle</span>{' '}
                      {kind === 'growth' ? a.growthAngle : a.suggestedAngle}
                    </p>
                  )}
                  <p className="text-faint small">
                    mention: {a.mentionRecommendation} · prompt {a.promptVersion}
                    {a.growthScore === null && ' · pre-v3, no growth score'}
                  </p>
                </div>
              )}

              {item.drafts.map((d) => (
                <div key={d.draftId} className="draft">
                  <div className="card-head">
                    <span className="eyebrow-muted">Draft reply</span>
                    <button className="btn btn-ghost btn-sm" onClick={() => copy(d)}>
                      <Copy size={13} /> {copied === d.draftId ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                  <p className="draft-body">{d.body}</p>
                </div>
              ))}

              {a && kind && item.drafts.length === 0 && (
                <div className="row">
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => draft(item)}
                    disabled={busy === item.itemId}
                  >
                    <PenLine size={13} /> {busy === item.itemId ? 'Writing…' : `Draft ${kind} reply`}
                  </button>
                </div>
              )}

              {a && !kind && (
                <p className="text-faint small">
                  Neither a brand nor a growth opportunity — no reply will be drafted.
                </p>
              )}
            </article>
          );
        })}
      </div>
    </>
  );
}
