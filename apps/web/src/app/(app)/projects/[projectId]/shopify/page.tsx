'use client';

import { use, useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  BookOpen,
  CheckSquare,
  Clock,
  Download,
  ExternalLink,
  Eye,
  MessagesSquare,
  PenLine,
  RefreshCw,
  Settings2,
  Square,
  ThumbsUp,
} from 'lucide-react';
import PageHeader from '@/components/PageHeader';
import { apiGet, apiPost, apiFetch, ApiError } from '@/lib/api';
import { SKIP_REASON_LABEL, type SkipReason } from '@/modules/shopify/topics';
import { ENGAGEMENT_LABEL, type Understanding } from '@/modules/shopify/understand';
import { MODE_HELP, MODE_LABEL, REPLY_MODES, type ReplyMode } from '@/modules/shopify/reply';
import type { ShopifyClientProfile } from '@/modules/shopify/client';
import { topicWebUrl, type ShopifyCategory, type ShopifySort } from '@/modules/shopify/categories';
import type { ShopifyModuleConfig } from '@/modules/shopify/config';

// Shopify Community — stage one.
//
// ════════════════════════════════════════════════════════════════════════════
// THE LIST ON THIS SCREEN IS TITLES, AND THAT IS THE WHOLE POINT
//
// Covers opened every thread, stored every post, and then found 93% were not
// worth answering. Here a fetch reads only what a board listing already says —
// title, replies, views, likes, whether it is solved — and a PERSON ticks what
// gets opened. No model is called anywhere on this screen.
//
// So the row has to carry enough to decide with. A title alone is not enough
// to judge a conversation; the counts are what separate "nobody cares" from
// "everybody has this question and nobody answered it", which is the most
// valuable shape on the board and the one that looks like silence.
// ════════════════════════════════════════════════════════════════════════════

interface StoredTopic {
  id: number;
  slug: string;
  title: string;
  excerpt: string;
  categoryId: number;
  tags: string[];
  replies: number;
  postsCount: number;
  views: number;
  likeCount: number;
  createdAtMs: number | null;
  lastPostedAtMs: number | null;
  hasAcceptedAnswer: boolean;
  skipReasons: SkipReason[];
  firstSeenAtMs: number | null;
  selected: boolean;
  analysedAtMs: number | null;
}

interface FetchResult {
  sort: string;
  requests: number;
  requestsPlanned: number;
  saved: { created: number; updated: number };
  skipped: Partial<Record<SkipReason, number>>;
  categories: {
    id: number;
    name: string;
    read: number;
    worthReading: number;
    pagesRead: number;
    truncated: boolean;
    error: string | null;
  }[];
}

interface Evidence {
  postNumber: number;
  username: string;
  quote: string;
  likeCount: number;
  isAcceptedAnswer: boolean;
}

interface Reading {
  topicId: number;
  title: string;
  url: string;
  understanding: Understanding;
  evidence: Evidence[];
  postsSeen: number;
  postsTotal: number;
  truncated: boolean;
  wouldRepeat: boolean;
  readAtMs?: number;
}

interface ReadResult {
  read: number;
  skippedAsFresh: number;
  notReached: number;
  unreadable: number;
  results: { topicId: number; title: string; engagement: string; wouldRepeat: boolean }[];
  failed: { topicId: number; title: string; error: string }[];
  message?: string;
}

interface Draft {
  draftId: string;
  topicId: number;
  mode: ReplyMode;
  text: string;
  words: number;
  angle: string;
  betterBecause: string;
  usedSourceIds: string[];
  forbiddenHits: string[];
  status: 'pending' | 'approved' | 'rejected';
  createdAtMs: number;
}

interface SortMeta {
  id: ShopifySort;
  label: string;
  help: string;
}

type Filter = 'worth' | 'selected' | 'read' | 'drafted' | 'skipped' | 'all';

const FILTER_LABEL: Record<Filter, string> = {
  worth: 'Worth reading',
  selected: 'Picked',
  read: 'Read',
  drafted: 'Drafted',
  skipped: 'Set aside',
  all: 'All',
};

const FILTER_HELP: Record<Filter, string> = {
  worth: 'Nothing objected to these. Tick the ones you want opened.',
  selected: 'What you have picked for a full read.',
  read: 'Opened and understood — what the thread is about, what has already been said, and what is missing.',
  drafted: 'Threads with a reply written. Nothing here has been posted — approving records that you read it and agreed.',
  skipped: 'Read and set aside, with the reason. Nothing here cost a model call.',
  all: 'Every topic the fetch saw, whatever the screen said about it.',
};

const age = (ms: number | null): string => {
  if (ms === null) return 'no date';
  const d = Math.floor((Date.now() - ms) / 86_400_000);
  if (d <= 0) return 'today';
  if (d === 1) return 'yesterday';
  if (d < 30) return `${d}d ago`;
  if (d < 365) return `${Math.floor(d / 30)}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
};

export default function ShopifyPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = use(params);

  const [config, setConfig] = useState<ShopifyModuleConfig | null>(null);
  const [catalogue, setCatalogue] = useState<ShopifyCategory[]>([]);
  const [catalogueError, setCatalogueError] = useState<string | null>(null);
  const [sorts, setSorts] = useState<SortMeta[]>([]);
  const [topics, setTopics] = useState<StoredTopic[]>([]);

  const [tab, setTab] = useState<'topics' | 'boards' | 'client'>('topics');
  const [filter, setFilter] = useState<Filter>('worth');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<FetchResult | null>(null);
  const [readings, setReadings] = useState<Reading[]>([]);
  const [readResult, setReadResult] = useState<ReadResult | null>(null);
  const [openReading, setOpenReading] = useState<number | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [hasClient, setHasClient] = useState(false);
  const [sourceCount, setSourceCount] = useState(0);

  const load = useCallback(async () => {
    try {
      const [settings, stored, read, drafted] = await Promise.all([
        apiGet<{
          config: ShopifyModuleConfig;
          catalogue: ShopifyCategory[];
          catalogueError: string | null;
          sorts: SortMeta[];
        }>(`/api/projects/${projectId}/shopify`),
        apiGet<{ topics: StoredTopic[] }>(`/api/projects/${projectId}/shopify/topics?limit=400`),
        apiGet<{ readings: Reading[] }>(`/api/projects/${projectId}/shopify/read?limit=200`),
        apiGet<{ drafts: Draft[]; hasClientProfile: boolean; sourceCount: number }>(
          `/api/projects/${projectId}/shopify/draft?limit=200`,
        ),
      ]);
      setConfig(settings.config);
      setCatalogue(settings.catalogue);
      setCatalogueError(settings.catalogueError);
      setSorts(settings.sorts);
      setTopics(stored.topics);
      setReadings(read.readings);
      setDrafts(drafted.drafts);
      setHasClient(drafted.hasClientProfile);
      setSourceCount(drafted.sourceCount);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The Shopify module could not be loaded.');
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const saveConfig = async (next: ShopifyModuleConfig) => {
    setBusy('config');
    setError(null);
    try {
      const res = await apiFetch<{ config: ShopifyModuleConfig }>(`/api/projects/${projectId}/shopify`, {
        method: 'PUT',
        body: JSON.stringify({ config: next }),
      });
      // What comes back is what was STORED, not what was sent — a board the
      // server dropped has to disappear from the screen too.
      setConfig(res.config);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Those settings were not saved.');
    } finally {
      setBusy(null);
    }
  };

  const runFetch = async () => {
    setBusy('fetch');
    setError(null);
    setResult(null);
    try {
      const res = await apiPost<FetchResult>(`/api/projects/${projectId}/shopify/fetch`, {});
      setResult(res);
      const stored = await apiGet<{ topics: StoredTopic[] }>(
        `/api/projects/${projectId}/shopify/topics?limit=400`,
      );
      setTopics(stored.topics);
      setTab('topics');
      setFilter('worth');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The fetch failed.');
    } finally {
      setBusy(null);
    }
  };

  /**
   * Open the picked topics and read them.
   *
   * ⚠️ THE ONLY BUTTON ON THIS SCREEN THAT SPENDS MODEL CREDIT — one request to
   * the community and one model call per topic. Which is why it says how many
   * it is about to read, and why nothing selects topics for you.
   */
  const runRead = async (topicIds?: number[]) => {
    setBusy(topicIds?.length === 1 ? `read:${topicIds[0]}` : 'read');
    setError(null);
    setReadResult(null);
    try {
      const res = await apiPost<ReadResult>(`/api/projects/${projectId}/shopify/read`,
        topicIds?.length ? { topicIds } : {});
      setReadResult(res);
      const [stored, read] = await Promise.all([
        apiGet<{ topics: StoredTopic[] }>(`/api/projects/${projectId}/shopify/topics?limit=400`),
        apiGet<{ readings: Reading[] }>(`/api/projects/${projectId}/shopify/read?limit=200`),
        apiGet<{ drafts: Draft[]; hasClientProfile: boolean; sourceCount: number }>(
          `/api/projects/${projectId}/shopify/draft?limit=200`,
        ),
      ]);
      setTopics(stored.topics);
      setReadings(read.readings);
      if (res.read > 0) setFilter('read');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Those topics could not be read.');
    } finally {
      setBusy(null);
    }
  };

  /**
   * Write a reply for one thread in one mode.
   *
   * ⚠️ THE MODE IS ON THE BUTTON. Covers had a Draft button that wrote for
   * "whatever the last run qualified", and the operator's verdict was that it
   * could not say what it was about to do. Here the row names the thread and
   * the button names the mode.
   */
  const runDraft = async (topicId: number, mode: ReplyMode) => {
    setBusy(`draft:${topicId}:${mode}`);
    setError(null);
    try {
      await apiPost(`/api/projects/${projectId}/shopify/draft`, { topicId, mode });
      const d = await apiGet<{ drafts: Draft[] }>(`/api/projects/${projectId}/shopify/draft?limit=200`);
      setDrafts(d.drafts);
      setOpenReading(topicId);
    } catch (err) {
      // The server's refusals are written to be read — "no knowledge source
      // speaks to this thread" tells you what to do next. Shown verbatim.
      setError(err instanceof ApiError ? err.message : 'That reply could not be written.');
    } finally {
      setBusy(null);
    }
  };

  const decide = async (draftId: string, status: 'approved' | 'rejected') => {
    setDrafts((prev) => prev.map((d) => (d.draftId === draftId ? { ...d, status } : d)));
    try {
      await apiFetch(`/api/projects/${projectId}/shopify/draft`, {
        method: 'PATCH',
        body: JSON.stringify({ draftId, status }),
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That decision was not saved.');
    }
  };

  const setPicked = async (ids: number[], selected: boolean) => {
    if (!ids.length) return;
    // Optimistic, because ticking a checkbox that waits for a round-trip feels
    // broken. Reconciled from the server's own count below.
    setTopics((prev) => prev.map((t) => (ids.includes(t.id) ? { ...t, selected } : t)));
    try {
      await apiFetch<{ changed: number }>(`/api/projects/${projectId}/shopify/topics`, {
        method: 'PATCH',
        body: JSON.stringify({ topicIds: ids, selected }),
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That selection was not saved.');
      const stored = await apiGet<{ topics: StoredTopic[] }>(
        `/api/projects/${projectId}/shopify/topics?limit=400`,
      );
      setTopics(stored.topics);
    }
  };

  const byId = useMemo(() => new Map(catalogue.map((c) => [c.id, c])), [catalogue]);
  const readingByTopic = useMemo(() => new Map(readings.map((r) => [r.topicId, r])), [readings]);
  const draftsByTopic = useMemo(() => {
    const m = new Map<number, Draft[]>();
    for (const d of drafts) m.set(d.topicId, [...(m.get(d.topicId) ?? []), d]);
    return m;
  }, [drafts]);

  /** Which modes to OFFER. Whether a particular thread has a supporting source
   *  is answered by the server on the attempt — asking per row would be one
   *  request per row for a question most rows share. */
  const modeAvailable = (mode: ReplyMode): boolean =>
    mode === 'open' ? true : mode === 'growth' ? hasClient : hasClient && sourceCount > 0;
  const selectedIds = useMemo(() => new Set((config?.categories ?? []).map((c) => c.id)), [config]);

  const visible = useMemo(() => {
    const rows =
      filter === 'drafted'
        ? topics.filter((t) => draftsByTopic.has(t.id))
        : filter === 'read'
        ? topics.filter((t) => readingByTopic.has(t.id))
        : filter === 'worth'
        ? topics.filter((t) => t.skipReasons.length === 0)
        : filter === 'selected'
          ? topics.filter((t) => t.selected)
          : filter === 'skipped'
            ? topics.filter((t) => t.skipReasons.length > 0)
            : topics;
    return [...rows].sort((a, b) => (b.lastPostedAtMs ?? 0) - (a.lastPostedAtMs ?? 0));
    // `draftsByTopic` belongs here: without it the Drafted list is computed
    // once and never again, so writing a reply while that chip is open leaves
    // the row invisible until something else forces a re-render. Caught by
    // exhaustive-deps rather than by a person noticing an empty list.
  }, [topics, filter, readingByTopic, draftsByTopic]);

  const counts = useMemo(
    () => ({
      worth: topics.filter((t) => t.skipReasons.length === 0).length,
      selected: topics.filter((t) => t.selected).length,
      read: topics.filter((t) => readingByTopic.has(t.id)).length,
      drafted: topics.filter((t) => draftsByTopic.has(t.id)).length,
      skipped: topics.filter((t) => t.skipReasons.length > 0).length,
      all: topics.length,
    }),
    [topics, readingByTopic, draftsByTopic],
  );

  const allVisiblePicked = visible.length > 0 && visible.every((t) => t.selected);

  return (
    <>
      <PageHeader
        title="Shopify Community"
        description="Read the boards by title and metadata. Nothing is opened, analysed or drafted until you pick it."
        crumbs={[
          { label: 'Projects', href: '/projects' },
          { label: 'Project', href: `/projects/${projectId}` },
          { label: 'Shopify Community' },
        ]}
        action={
          <div className="row">
            <button className="btn btn-secondary btn-sm" onClick={runFetch} disabled={!!busy || !config?.categories.length}>
              <Download size={14} /> {busy === 'fetch' ? 'Fetching…' : 'Fetch new'}
            </button>
            {/* Says the number BEFORE it is pressed. This is the only control
                here that costs model credit — one call per topic — and a button
                that hides its own bill is how a run surprises somebody. */}
            <button
              className="btn btn-primary btn-sm"
              onClick={() => void runRead()}
              disabled={!!busy || counts.selected === 0}
              title="One request to the community and one model call per topic"
            >
              <BookOpen size={14} />{' '}
              {busy === 'read' ? 'Reading…' : `Read ${counts.selected || ''} picked`}
            </button>
          </div>
        }
      />

      {error && (
        <div className="alert alert-error">
          <AlertTriangle size={15} aria-hidden /> {error}
        </div>
      )}

      <div className="tabs">
        {(['topics', 'boards', 'client'] as const).map((t) => (
          <button
            key={t}
            className={`tab ${tab === t ? 'active' : ''}`}
            onClick={() => setTab(t)}
            style={{ background: 'none', border: 'none', cursor: 'pointer' }}
          >
            {t === 'topics' ? 'Topics' : t === 'boards' ? 'Boards & settings' : 'Client details'}
          </button>
        ))}
      </div>

      {result && (
        <div className="alert alert-info">
          <div>
            Read <strong>{result.categories.reduce((n, c) => n + c.read, 0)}</strong> topics from{' '}
            {result.categories.length} board{result.categories.length === 1 ? '' : 's'} in {result.requests}{' '}
            request{result.requests === 1 ? '' : 's'}
            {result.requests < result.requestsPlanned && ` of ${result.requestsPlanned} planned`}.{' '}
            {result.saved.created} new, {result.saved.updated} already held.{' '}
            <strong>{result.categories.reduce((n, c) => n + c.worthReading, 0)} worth reading.</strong>
          </div>
          {Object.keys(result.skipped).length > 0 && (
            <div className="small text-dim" style={{ marginTop: '0.3rem' }}>
              Set aside:{' '}
              {Object.entries(result.skipped)
                .sort((a, b) => b[1] - a[1])
                .map(([r, n]) => `${n} ${SKIP_REASON_LABEL[r as SkipReason].toLowerCase()}`)
                .join(' · ')}
            </div>
          )}
          {result.categories.some((c) => c.error) && (
            <ul className="small" style={{ marginTop: '0.4rem' }}>
              {result.categories
                .filter((c) => c.error)
                .map((c) => (
                  <li key={c.id}>
                    <strong>{c.name}</strong> — {c.error}
                  </li>
                ))}
            </ul>
          )}
        </div>
      )}

      {readResult && (
        <div className="alert alert-info">
          <div>
            Read <strong>{readResult.read}</strong> discussion{readResult.read === 1 ? '' : 's'}.
            {readResult.skippedAsFresh > 0 &&
              ` ${readResult.skippedAsFresh} already read at this prompt version — press Read again on a row to redo one.`}
            {readResult.notReached > 0 && ` ${readResult.notReached} not reached (per-run cap).`}
            {readResult.unreadable > 0 && ` ${readResult.unreadable} came back unreadable.`}
          </div>
          {readResult.message && <div className="small text-dim">{readResult.message}</div>}
          {readResult.failed.length > 0 && (
            <ul className="small" style={{ marginTop: '0.4rem' }}>
              {readResult.failed.map((f) => (
                <li key={f.topicId}>
                  <strong>{f.title}</strong> — {f.error}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {tab === 'topics' && (
        <div className="sections">
          <section className="card">
            <div className="tabs-inline">
              {(['worth', 'selected', 'read', 'drafted', 'skipped', 'all'] as const).map((f) => (
                <button key={f} className={`chip-tab ${filter === f ? 'active' : ''}`} onClick={() => setFilter(f)}>
                  {FILTER_LABEL[f]}
                  <span className="chip-count">{counts[f]}</span>
                </button>
              ))}
            </div>
            <p className="text-dim small" style={{ marginTop: '0.4rem' }}>
              {FILTER_HELP[filter]}
            </p>
          </section>

          <section className="card">
            <div className="card-head">
              <h3>{FILTER_LABEL[filter]}</h3>
              <div className="row">
                <span className="badge">{visible.length}</span>
                {visible.length > 0 && (
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => void setPicked(visible.map((t) => t.id), !allVisiblePicked)}
                  >
                    {allVisiblePicked ? <Square size={13} /> : <CheckSquare size={13} />}
                    {allVisiblePicked ? 'Clear all' : 'Pick all shown'}
                  </button>
                )}
              </div>
            </div>

            {visible.length === 0 ? (
              <div className="empty">
                <p>
                  {counts.all === 0
                    ? 'Nothing fetched yet. Choose boards under Boards & settings, then press Fetch new.'
                    : 'Nothing here. Try another filter.'}
                </p>
              </div>
            ) : (
              <ul className="list">
                {visible.map((t) => (
                  <li key={t.id} className="list-row" style={{ display: 'block' }}>
                    <div className="row" style={{ gap: '0.75rem', alignItems: 'flex-start' }}>
                      <input
                        type="checkbox"
                        checked={t.selected}
                        onChange={(e) => void setPicked([t.id], e.target.checked)}
                        aria-label={`Pick "${t.title}"`}
                        style={{ marginTop: '0.35rem', flexShrink: 0 }}
                      />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="row" style={{ justifyContent: 'space-between', gap: '1rem' }}>
                          <strong>{t.title || 'Untitled topic'}</strong>
                          <div className="row" style={{ flexShrink: 0, gap: '0.35rem' }}>
                            {t.hasAcceptedAnswer && <span className="badge">solved</span>}
                            {t.analysedAtMs !== null && <span className="badge">analysed</span>}
                          </div>
                        </div>

                        {t.excerpt && (
                          <p className="small text-dim" style={{ margin: '0.2rem 0 0' }}>
                            {t.excerpt}
                          </p>
                        )}

                        {/* The counts are the decision. `replies` is derived from
                            posts_count — Discourse's own reply_count is not the
                            number of replies and reads 0 on a 23-post thread. */}
                        <div
                          className="row small text-dim"
                          style={{ flexWrap: 'wrap', gap: '0.75rem', marginTop: '0.3rem' }}
                        >
                          <span>
                            <MessagesSquare size={12} aria-hidden /> {t.replies}{' '}
                            {t.replies === 1 ? 'reply' : 'replies'}
                          </span>
                          <span>
                            <Eye size={12} aria-hidden /> {t.views} views
                          </span>
                          <span>
                            <ThumbsUp size={12} aria-hidden /> {t.likeCount}
                          </span>
                          <span>
                            <Clock size={12} aria-hidden /> {age(t.lastPostedAtMs)}
                          </span>
                          <span>{byId.get(t.categoryId)?.name ?? `board ${t.categoryId}`}</span>
                          <a href={topicWebUrl(t.id, t.slug)} target="_blank" rel="noopener noreferrer">
                            Open <ExternalLink size={11} aria-hidden />
                          </a>
                        </div>

                        {t.skipReasons.length > 0 && (
                          <div className="small text-dim" style={{ marginTop: '0.25rem' }}>
                            {t.skipReasons.map((r) => SKIP_REASON_LABEL[r]).join(' · ')}
                          </div>
                        )}

                        {/* The reading, on the row it belongs to. A per-row
                            Read button exists for the same reason Covers grew
                            one: a button that drafts "whatever is ticked"
                            cannot say what it is about to work on. */}
                        <div className="row" style={{ gap: '0.5rem', marginTop: '0.4rem' }}>
                          {readingByTopic.has(t.id) ? (
                            <button
                              className="btn btn-ghost btn-sm"
                              onClick={() => setOpenReading(openReading === t.id ? null : t.id)}
                            >
                              {openReading === t.id ? 'Hide reading' : 'Show reading'}
                            </button>
                          ) : (
                            <button
                              className="btn btn-secondary btn-sm"
                              onClick={() => void runRead([t.id])}
                              disabled={!!busy}
                            >
                              <BookOpen size={13} />{' '}
                              {busy === `read:${t.id}` ? 'Reading…' : 'Read this'}
                            </button>
                          )}
                        </div>

                        {/* THE THREE MODES, ON THE ROW. Only offered once the
                            thread has been read — every prompt is built around
                            what the thread already contains. */}
                        {readingByTopic.has(t.id) && (
                          <div className="row" style={{ gap: '0.4rem', marginTop: '0.4rem', flexWrap: 'wrap' }}>
                            <span className="small text-dim">Draft a reply:</span>
                            {REPLY_MODES.map((m) => (
                              <button
                                key={m}
                                className={`btn btn-sm ${m === 'open' ? 'btn-primary' : 'btn-secondary'}`}
                                onClick={() => void runDraft(t.id, m)}
                                disabled={!!busy || !modeAvailable(m)}
                                title={
                                  modeAvailable(m)
                                    ? MODE_HELP[m]
                                    : m === 'growth'
                                      ? 'Add client details first — see the Client details tab.'
                                      : 'Needs client details and at least one knowledge source.'
                                }
                              >
                                <PenLine size={12} />{' '}
                                {busy === `draft:${t.id}:${m}` ? 'Writing…' : MODE_LABEL[m]}
                              </button>
                            ))}
                          </div>
                        )}

                        {openReading === t.id && readingByTopic.has(t.id) && (
                          <ReadingPanel reading={readingByTopic.get(t.id)!} />
                        )}

                        {openReading === t.id &&
                          (draftsByTopic.get(t.id) ?? []).map((d) => (
                            <DraftPanel key={d.draftId} draft={d} onDecide={decide} />
                          ))}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}

      {tab === 'client' && config && (
        <ClientTab
          projectId={projectId}
          client={config.client}
          sourceCount={sourceCount}
          onSaved={(c) => setConfig({ ...config, client: c })}
          onError={setError}
        />
      )}

      {tab === 'boards' && config && (
        <BoardsTab
          config={config}
          catalogue={catalogue}
          catalogueError={catalogueError}
          sorts={sorts}
          selectedIds={selectedIds}
          busy={busy === 'config'}
          onSave={saveConfig}
        />
      )}
    </>
  );
}

/**
 * What one discussion turned out to be.
 *
 * ⚠️ `alreadySaid` IS AS IMPORTANT AS `whatIsMissing`, AND IT IS SHOWN FIRST
 * WHEN IT MATTERS. The operator asked for awareness rather than originality:
 * the useful thing is not "here is a gap", it is "here is what you would be
 * talking over if you posted the obvious reply". Covers' drafts died on exactly
 * that — "generic advice that adds nothing to the thread" — and nothing on its
 * screen ever showed what the thread had already said.
 */
function ReadingPanel({ reading }: { reading: Reading }) {
  const u = reading.understanding;
  return (
    <div
      className="card"
      style={{ marginTop: '0.6rem', padding: '0.9rem 1rem', display: 'flex', flexDirection: 'column', gap: '0.7rem' }}
    >
      <div className="row" style={{ justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
        <span className="badge">{ENGAGEMENT_LABEL[u.engagement] ?? u.engagement}</span>
        <span className="small text-dim">
          {reading.postsSeen} of {reading.postsTotal} posts read
          {reading.truncated && ' (partial)'}
        </span>
      </div>

      <div>
        <span className="eyebrow-muted">What they are asking</span>
        <p style={{ margin: '0.15rem 0 0' }}>{u.concern}</p>
        {u.askerContext && <p className="small text-dim" style={{ margin: '0.15rem 0 0' }}>{u.askerContext}</p>}
      </div>

      {u.offered.length > 0 && (
        <div>
          <span className="eyebrow-muted">Already offered ({u.offered.length})</span>
          <ul className="list" style={{ marginTop: '0.15rem' }}>
            {u.offered.map((o, i) => (
              <li key={i} className="list-row small" style={{ display: 'block' }}>
                {o.endorsed && <span className="badge badge-success" style={{ marginRight: '0.4rem' }}>endorsed</span>}
                {o.approach}
                <span className="text-dim">
                  {' '}
                  — {o.byUsername}
                  {o.postNumber > 0 && ` #${o.postNumber}`}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {u.alreadySaid.length > 0 && (
        <div>
          <span className="eyebrow-muted">Saying this again would add nothing</span>
          <ul className="small text-dim" style={{ margin: '0.15rem 0 0', paddingLeft: '1.1rem' }}>
            {u.alreadySaid.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <span className="eyebrow-muted">Nobody has said</span>
        <p style={{ margin: '0.15rem 0 0' }}>
          {u.whatIsMissing || <em className="text-dim">Nothing obvious is missing — this one is well answered.</em>}
        </p>
      </div>

      {u.worthJoining && (
        <div>
          <span className="eyebrow-muted">Worth joining?</span>
          <p className="small" style={{ margin: '0.15rem 0 0' }}>{u.worthJoining}</p>
          {reading.wouldRepeat && (
            <p className="small text-dim" style={{ margin: '0.2rem 0 0' }}>
              The thread is answered and nothing was identified as missing — a reply here would be repetition.
            </p>
          )}
        </div>
      )}

      {reading.evidence.length > 0 && (
        <details>
          <summary className="small text-dim" style={{ cursor: 'pointer' }}>
            The posts this is based on ({reading.evidence.length})
          </summary>
          <ul className="list" style={{ marginTop: '0.3rem' }}>
            {reading.evidence.map((e) => (
              <li key={e.postNumber} className="list-row small" style={{ display: 'block' }}>
                <div className="text-dim">
                  #{e.postNumber} {e.username}
                  {e.likeCount > 0 && ` · ${e.likeCount} likes`}
                  {e.isAcceptedAnswer && ' · accepted answer'}
                </div>
                <div style={{ whiteSpace: 'pre-wrap' }}>{e.quote}</div>
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className="small text-dim">
        <a href={reading.url} target="_blank" rel="noopener noreferrer">
          Read the thread on the community <ExternalLink size={11} aria-hidden />
        </a>
      </div>
    </div>
  );
}

/**
 * One written reply.
 *
 * ⚠️ A FORBIDDEN PHRASE IS THE FIRST THING SHOWN, and the draft is shown WITH
 * it rather than discarded. The list is checked after generation rather than
 * merely asked for in the prompt — an instruction is a request, this is the
 * rule — and a reviewer needs to see both what was written and what it broke.
 *
 * An EMPTY draft is a decision, not a failure: growth and brand are both told
 * to write nothing rather than force a mention, so `angle` carries the reason.
 */
function DraftPanel({
  draft,
  onDecide,
}: {
  draft: Draft;
  onDecide: (draftId: string, status: 'approved' | 'rejected') => void | Promise<void>;
}) {
  const empty = draft.text.trim().length === 0;
  return (
    <div
      className="card"
      style={{ marginTop: '0.6rem', padding: '0.9rem 1rem', display: 'flex', flexDirection: 'column', gap: '0.6rem' }}
    >
      <div className="row" style={{ justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
        <div className="row" style={{ gap: '0.4rem' }}>
          <span className="badge">{MODE_LABEL[draft.mode]}</span>
          {!empty && <span className="small text-dim">{draft.words} words</span>}
          {draft.status !== 'pending' && <span className="badge">{draft.status}</span>}
        </div>
        {draft.status === 'pending' && !empty && (
          <div className="row" style={{ gap: '0.4rem' }}>
            <button className="btn btn-ghost btn-sm" onClick={() => void navigator.clipboard?.writeText(draft.text)}>
              Copy
            </button>
            <button className="btn btn-secondary btn-sm" onClick={() => void onDecide(draft.draftId, 'approved')}>
              Approve
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => void onDecide(draft.draftId, 'rejected')}>
              Reject
            </button>
          </div>
        )}
      </div>

      {draft.forbiddenHits.length > 0 && (
        <div className="alert alert-error" style={{ margin: 0 }}>
          <AlertTriangle size={15} aria-hidden /> Contains {draft.forbiddenHits.length} forbidden phrase
          {draft.forbiddenHits.length === 1 ? '' : 's'}: <strong>{draft.forbiddenHits.join(', ')}</strong>. Edit before
          using it.
        </div>
      )}

      {empty ? (
        <p className="text-dim">
          <em>Nothing written, on purpose.</em> {draft.angle}
        </p>
      ) : (
        <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{draft.text}</p>
      )}

      {draft.angle && !empty && (
        <div>
          <span className="eyebrow-muted">The angle</span>
          <p className="small text-dim" style={{ margin: '0.1rem 0 0' }}>{draft.angle}</p>
        </div>
      )}

      {draft.betterBecause && (
        <div>
          {/* The model's own answer to "is this better than what is already
              there?". Not a measurement — shown so a reviewer can disagree. */}
          <span className="eyebrow-muted">Why this beats what is there</span>
          <p className="small text-dim" style={{ margin: '0.1rem 0 0' }}>{draft.betterBecause}</p>
        </div>
      )}

      {draft.usedSourceIds.length > 0 && (
        <div className="small text-dim">
          Drew on {draft.usedSourceIds.length} knowledge source{draft.usedSourceIds.length === 1 ? '' : 's'}.
        </div>
      )}
    </div>
  );
}

/**
 * Who the client is, and where those words came from.
 *
 * ⚠️ THE KNOWLEDGE ITSELF IS NOT HERE, AND THAT IS NOT AN OMISSION. `sources`
 * is a PROJECT-level collection — Reddit's knowledge screen writes to
 * /api/projects/:id/sources, and this module reads the same store. There is one
 * client and one knowledge base; a second importer would only create a second
 * thing to keep in sync. This tab links there rather than duplicating it.
 */
function ClientTab({
  projectId,
  client,
  sourceCount,
  onSaved,
  onError,
}: {
  projectId: string;
  client: ShopifyClientProfile;
  sourceCount: number;
  onSaved: (c: ShopifyClientProfile) => void;
  onError: (m: string | null) => void;
}) {
  const [draft, setDraft] = useState<ShopifyClientProfile>(client);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const save = async () => {
    setBusy('save');
    onError(null);
    setNote(null);
    try {
      const res = await apiFetch<{ client: ShopifyClientProfile }>(
        `/api/projects/${projectId}/shopify/client`,
        { method: 'PUT', body: JSON.stringify({ client: draft }) },
      );
      setDraft(res.client);
      onSaved(res.client);
      setNote('Saved.');
    } catch (err) {
      onError(err instanceof ApiError ? err.message : 'Those details were not saved.');
    } finally {
      setBusy(null);
    }
  };

  const sync = async () => {
    setBusy('sync');
    onError(null);
    setNote(null);
    try {
      const res = await apiPost<{ client: ShopifyClientProfile; copied: Record<string, unknown> }>(
        `/api/projects/${projectId}/shopify/client`,
        {},
      );
      setDraft(res.client);
      onSaved(res.client);
      setNote(`Copied from Reddit — ${res.copied.forbiddenPhrases} forbidden phrase(s) included.`);
    } catch (err) {
      onError(err instanceof ApiError ? err.message : 'Nothing could be copied from Reddit.');
    } finally {
      setBusy(null);
    }
  };

  const field = (
    label: string,
    key: 'companyDescription' | 'targetCustomer' | 'productService' | 'brandMentionStyle',
    help: string,
    rows = 3,
  ) => (
    <div className="field">
      <label className="label">{label}</label>
      <textarea rows={rows} value={draft[key]} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} />
      <p className="text-dim small" style={{ marginTop: '0.2rem' }}>{help}</p>
    </div>
  );

  return (
    <div className="sections">
      <section className="card">
        <div className="card-head">
          <h3>Client details</h3>
          <button className="btn btn-secondary btn-sm" onClick={() => void sync()} disabled={!!busy}>
            <RefreshCw size={13} /> {busy === 'sync' ? 'Copying…' : 'Copy from Reddit'}
          </button>
        </div>

        <p className="text-dim small">
          Its own copy, not a live read of the Reddit module — a merchant forum is not a subreddit and the two may want
          to sound different.{' '}
          {client.syncedFromRedditAtMs
            ? `Last copied from Reddit ${age(client.syncedFromRedditAtMs)}.`
            : 'These were typed here.'}
        </p>

        {note && <div className="alert alert-info">{note}</div>}

        <div className="grid-form">
          {field('What the company does', 'companyDescription', 'Needed before Growth or Brand can write anything.')}
          {field('Who they serve', 'targetCustomer', 'Shapes register more than content.', 2)}
          {field('What they sell', 'productService', 'Needed before a reply may name them.', 2)}
          {field(
            'How they may be mentioned',
            'brandMentionStyle',
            'Only Brand is told this. "Say we, not they." "Never claim to be the cheapest."',
          )}
        </div>

        <div className="field">
          <label className="label">Phrases that must never appear</label>
          <textarea
            rows={3}
            value={draft.forbiddenPhrases.join('\n')}
            onChange={(e) =>
              setDraft({ ...draft, forbiddenPhrases: e.target.value.split('\n').map((p) => p.trim()).filter(Boolean) })
            }
          />
          <p className="text-dim small" style={{ marginTop: '0.2rem' }}>
            One per line. ⚠️ The only rule that is <strong>checked</strong> rather than asked for — a draft containing
            one is stored and flagged, not silently discarded. Matched anywhere in the text, ignoring case, so a hyphen
            cannot defeat it.
          </p>
        </div>

        <div className="row">
          <button className="btn btn-primary btn-sm" onClick={() => void save()} disabled={!!busy}>
            {busy === 'save' ? 'Saving…' : 'Save'}
          </button>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h3>Knowledge</h3>
          <span className="badge">{sourceCount} source{sourceCount === 1 ? '' : 's'}</span>
        </div>
        <p className="text-dim small">
          Knowledge lives at the <strong>project</strong> level and is shared with Reddit — one client, one knowledge
          base. Add sources, or bulk-import them as JSON, on the knowledge screen; anything there is immediately
          available here.
        </p>
        {sourceCount === 0 && (
          <div className="alert alert-warn">
            <AlertTriangle size={15} aria-hidden /> No sources yet, so <strong>Brand</strong> cannot write anything —
            a reply may not name the client on no evidence. Open still works on any thread.
          </div>
        )}
        <div className="row">
          <a className="btn btn-secondary btn-sm" href={`/projects/${projectId}/reddit/knowledge`}>
            Open knowledge <ExternalLink size={13} />
          </a>
        </div>
      </section>
    </div>
  );
}

function BoardsTab({
  config,
  catalogue,
  catalogueError,
  sorts,
  selectedIds,
  busy,
  onSave,
}: {
  config: ShopifyModuleConfig;
  catalogue: ShopifyCategory[];
  catalogueError: string | null;
  sorts: SortMeta[];
  selectedIds: Set<number>;
  busy: boolean;
  onSave: (next: ShopifyModuleConfig) => void | Promise<void>;
}) {
  const toggle = (cat: ShopifyCategory) => {
    const next = selectedIds.has(cat.id)
      ? config.categories.filter((c) => c.id !== cat.id)
      : [...config.categories, cat];
    void onSave({ ...config, categories: next });
  };

  const planned = config.categories.length * config.pagesPerCategory;

  return (
    <div className="sections">
      <section className="card">
        <div className="card-head">
          <h3>
            <Settings2 size={16} aria-hidden /> How a fetch reads
          </h3>
        </div>

        <div className="grid-form">
          <div className="field">
            <label className="label">Order</label>
            <select value={config.sort} onChange={(e) => void onSave({ ...config, sort: e.target.value as ShopifySort })}>
              {sorts.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label className="label">Pages per board</label>
            <input
              type="number"
              min={1}
              max={20}
              value={config.pagesPerCategory}
              onChange={(e) => void onSave({ ...config, pagesPerCategory: Number(e.target.value) })}
            />
          </div>

          <div className="field">
            <label className="label">Quiet after (days)</label>
            <input
              type="number"
              min={1}
              max={365}
              value={config.limits.quietAfterDays}
              onChange={(e) =>
                void onSave({ ...config, limits: { ...config.limits, quietAfterDays: Number(e.target.value) } })
              }
            />
          </div>
        </div>

        <p className="text-dim small">
          {sorts.find((s) => s.id === config.sort)?.help}{' '}
          {/* Said BEFORE the button is pressed. A wide selection is a request
              count against somebody else's server, and it should be visible in
              advance rather than in a rate-limit error. */}
          <strong>
            {planned} request{planned === 1 ? '' : 's'}
          </strong>{' '}
          per fetch — one per page per board, a second apart. A page is 30 topics.
        </p>

        <label className="row small" style={{ gap: '0.35rem', marginTop: '0.5rem' }}>
          <input
            type="checkbox"
            checked={config.limits.skipAnswered}
            onChange={(e) => void onSave({ ...config, limits: { ...config.limits, skipAnswered: e.target.checked } })}
          />
          <span>
            <strong>Set aside topics that already have an accepted answer.</strong>{' '}
            <span className="text-dim">
              On, a solved question never reaches the queue. Off, they stay in view — they are poor places to add to and
              good places to learn what this board accepts as an answer.
            </span>
          </span>
        </label>
      </section>

      <section className="card">
        <div className="card-head">
          <h3>Boards</h3>
          <span className="badge">{config.categories.length} selected</span>
        </div>

        {catalogueError && (
          <div className="alert alert-warn">
            <AlertTriangle size={15} aria-hidden /> {catalogueError} Showing the shipped list instead — a board added
            recently may be missing until the community is reachable again.
          </div>
        )}

        <p className="text-dim small">
          Every board the community publishes. The six marketing ones are selected by default; there is no “Marketing”
          parent category on the site, so they are a starting point rather than a group.
        </p>

        <ul className="list">
          {catalogue.map((cat) => (
            <li key={cat.id} className="list-row">
              <label className="row" style={{ gap: '0.6rem', cursor: 'pointer', width: '100%' }}>
                <input
                  type="checkbox"
                  checked={selectedIds.has(cat.id)}
                  disabled={busy}
                  onChange={() => toggle(cat)}
                />
                <span style={{ flex: 1 }}>
                  <strong>{cat.name}</strong>
                  <span className="text-dim small">
                    {' '}
                    {cat.topicCount === null ? 'size not reported' : `${cat.topicCount.toLocaleString()} topics`}
                  </span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
