'use client';

import { use, useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  BookOpen,
  CheckSquare,
  ChevronDown,
  ChevronUp,
  Clock,
  Cpu,
  Download,
  ExternalLink,
  Eye,
  MessagesSquare,
  Settings2,
  Square,
  ThumbsUp,
  Send,
} from 'lucide-react';
import Link from 'next/link';
import PageHeader from '@/components/PageHeader';
import ModelPicker from '@/components/reddit/ModelPicker';
import ClientTab from '@/components/shopify/ClientTab';
import KnowledgeTab from '@/components/shopify/KnowledgeTab';
import ThreadDetail, { ScoreChips } from '@/components/shopify/ThreadDetail';
import { age, type Draft, type PostJob, type PostingContext, type StoredAssessment } from '@/components/shopify/types';
import type { PostingProps } from '@/components/shopify/DraftPanel';
import { apiGet, apiPost, apiFetch, ApiError } from '@/lib/api';
import { SKIP_REASON_LABEL, type SkipReason } from '@/modules/shopify/topics';
import { BRAND_OPPORTUNITY_MIN, isBrandOpportunity, topScore } from '@/modules/shopify/assess';
import type { ReplyMode } from '@/modules/shopify/modes';
import type { ShopifySource } from '@/modules/shopify/knowledge';
import { topicWebUrl, type ShopifyCategory, type ShopifySort } from '@/modules/shopify/categories';
import type { ShopifyModuleConfig } from '@/modules/shopify/config';

// Shopify Community.
//
// ════════════════════════════════════════════════════════════════════════════
// THE FLOW, IN THE OPERATOR'S ORDER — AND WHAT EACH STEP COSTS
//
//   Fetch      free — titles and counts from the board listings
//   Pick       a person ticks titles; nothing picks for them
//   Analyse    one model call per picked thread, on the QUESTION ONLY:
//              Open / Growth / Brand scored 0–10, each with its reason
//   Re-analyse the same, with a comment — the earlier analysis is kept
//   Draft      one model call: reads the REPLIES for the first time, says
//              what they already offer, writes something better
//
// The replies used to be read for every picked thread and then again for
// every draft. They are now read once, by the call that needs them.
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

interface AnalyseResult {
  analysed: number;
  skippedAsFresh: number;
  notReached: number;
  unreadable: number;
  failed: { topicId: number; title: string; error: string }[];
  message?: string;
}

interface DraftsResponse {
  drafts: Draft[];
  jobs: Record<string, PostJob>;
  hasClientProfile: boolean;
  canNameClient: boolean;
  sourceCount: number;
}

interface SortMeta {
  id: ShopifySort;
  label: string;
  help: string;
}

type Filter = 'worth' | 'selected' | 'analysed' | 'brand' | 'drafted' | 'skipped' | 'all';
type Tab = 'topics' | 'client' | 'knowledge' | 'settings';

const FILTERS: Filter[] = ['worth', 'selected', 'analysed', 'brand', 'drafted', 'skipped', 'all'];

const FILTER_LABEL: Record<Filter, string> = {
  worth: 'Worth reading',
  selected: 'Picked',
  analysed: 'Analysed',
  brand: 'Brand opportunities',
  drafted: 'Drafted',
  skipped: 'Set aside',
  all: 'All',
};

const FILTER_HELP: Record<Filter, string> = {
  worth: 'Nothing objected to these. Tick the ones you want analysed.',
  selected: 'What you have picked for analysis.',
  analysed: 'Scored from the question alone — which kind of reply fits, and why. Highest score first.',
  brand: `Brand scored ${BRAND_OPPORTUNITY_MIN} or more AND a knowledge source supports it — the threads where naming the client would genuinely help. Highest first.`,
  drafted: 'Threads with a reply written. An approved reply can be queued for the agent from its draft; nothing posts without that.',
  skipped: 'Set aside by the free screen, with the reason. Nothing here cost a model call.',
  all: 'Every topic the fetch saw, whatever the screen said about it.',
};

const TAB_LABEL: Record<Tab, string> = {
  topics: 'Topics',
  client: 'Client details',
  knowledge: 'Knowledge',
  settings: 'Boards & settings',
};

export default function ShopifyPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = use(params);

  const [config, setConfig] = useState<ShopifyModuleConfig | null>(null);
  const [catalogue, setCatalogue] = useState<ShopifyCategory[]>([]);
  const [catalogueError, setCatalogueError] = useState<string | null>(null);
  const [sorts, setSorts] = useState<SortMeta[]>([]);
  const [topics, setTopics] = useState<StoredTopic[]>([]);

  const [tab, setTab] = useState<Tab>('topics');
  const [filter, setFilter] = useState<Filter>('worth');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<FetchResult | null>(null);
  const [assessments, setAssessments] = useState<StoredAssessment[]>([]);
  const [analyseResult, setAnalyseResult] = useState<AnalyseResult | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  /** The draft that just arrived — marked "new" so the eye lands on it. */
  const [freshDraftId, setFreshDraftId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [hasClient, setHasClient] = useState(false);
  const [canNameClient, setCanNameClient] = useState(false);
  const [sources, setSources] = useState<ShopifySource[]>([]);
  const [postJobs, setPostJobs] = useState<Record<string, PostJob>>({});
  const [posting, setPosting] = useState<PostingContext | null>(null);
  const [postingDraft, setPostingDraft] = useState<string | null>(null);

  const topicsUrl = `/api/projects/${projectId}/shopify/topics?limit=400`;
  const analyseUrl = `/api/projects/${projectId}/shopify/analyse?limit=300`;
  const draftsUrl = `/api/projects/${projectId}/shopify/draft?limit=200`;

  const postingUrl = `/api/projects/${projectId}/shopify/post`;

  const applyDrafts = (d: DraftsResponse) => {
    setDrafts(d.drafts);
    setPostJobs(d.jobs ?? {});
    setHasClient(d.hasClientProfile);
    setCanNameClient(d.canNameClient);
  };

  const loadPosting = useCallback(async () => {
    try {
      setPosting(await apiGet<PostingContext>(`/api/projects/${projectId}/shopify/post`));
    } catch {
      // The drafts still render; the post control says it is loading.
    }
  }, [projectId]);

  const load = useCallback(async () => {
    try {
      const [settings, stored, analysed, drafted, knowledge] = await Promise.all([
        apiGet<{ config: ShopifyModuleConfig; catalogue: ShopifyCategory[]; catalogueError: string | null; sorts: SortMeta[] }>(
          `/api/projects/${projectId}/shopify`,
        ),
        apiGet<{ topics: StoredTopic[] }>(`/api/projects/${projectId}/shopify/topics?limit=400`),
        apiGet<{ assessments: StoredAssessment[] }>(`/api/projects/${projectId}/shopify/analyse?limit=300`),
        apiGet<DraftsResponse>(`/api/projects/${projectId}/shopify/draft?limit=200`),
        apiGet<{ sources: ShopifySource[] }>(`/api/projects/${projectId}/shopify/knowledge`),
      ]);
      setConfig(settings.config);
      setCatalogue(settings.catalogue);
      setCatalogueError(settings.catalogueError);
      setSorts(settings.sorts);
      setTopics(stored.topics);
      setAssessments(analysed.assessments);
      setDrafts(drafted.drafts);
      setPostJobs(drafted.jobs ?? {});
      setHasClient(drafted.hasClientProfile);
      setCanNameClient(drafted.canNameClient);
      setSources(knowledge.sources);
      // Accounts, agent readiness and Shopify's dry-run state — loaded with the
      // page, not in an effect of its own.
      void loadPosting();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The Shopify module could not be loaded.');
    }
  }, [projectId, loadPosting]);

  useEffect(() => {
    void load();
  }, [load]);


  // While the agent has a job in hand, refresh its state — a post takes minutes
  // and the screen should not need a reload to say it finished.
  const jobActive = Object.values(postJobs).some((j) => j.status === 'queued' || j.status === 'posting');
  useEffect(() => {
    if (!jobActive) return;
    const t = setInterval(() => {
      apiGet<DraftsResponse>(draftsUrl)
        .then((d) => {
          setDrafts(d.drafts);
          setPostJobs(d.jobs ?? {});
        })
        .catch(() => {});
    }, 8000);
    return () => clearInterval(t);
  }, [jobActive, draftsUrl]);

  const queuePost = async (draftId: string, accountId: string) => {
    setPostingDraft(draftId);
    setError(null);
    try {
      await apiPost(postingUrl, { draftId, accountId });
      applyDrafts(await apiGet<DraftsResponse>(draftsUrl));
      void loadPosting();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That reply could not be queued.');
    } finally {
      setPostingDraft(null);
    }
  };

  const cancelPost = async (jobId: string) => {
    setError(null);
    try {
      await apiFetch(postingUrl, { method: 'DELETE', body: JSON.stringify({ jobId }) });
      applyDrafts(await apiGet<DraftsResponse>(draftsUrl));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That job could not be cancelled.');
    }
  };

  const postingProps: PostingProps = {
    context: posting,
    jobs: postJobs,
    busyDraftId: postingDraft,
    onQueue: queuePost,
    onCancel: cancelPost,
  };

  const setShopifyDryRun = async (dryRun: boolean) => {
    setError(null);
    try {
      await apiPost('/api/agent/dry-run', { platform: 'shopify', dryRun });
      await loadPosting();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The dry-run switch was not changed.');
    }
  };

  const saveConfig = async (next: ShopifyModuleConfig) => {
    setBusy('config');
    setError(null);
    try {
      const res = await apiFetch<{ config: ShopifyModuleConfig }>(`/api/projects/${projectId}/shopify`, {
        method: 'PUT',
        body: JSON.stringify({ config: next }),
      });
      // What comes back is what was STORED, not what was sent.
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
      setResult(await apiPost<FetchResult>(`/api/projects/${projectId}/shopify/fetch`, {}));
      setTopics((await apiGet<{ topics: StoredTopic[] }>(topicsUrl)).topics);
      setTab('topics');
      setFilter('worth');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The fetch failed.');
    } finally {
      setBusy(null);
    }
  };

  /**
   * Analyse the picked topics, or one row, or re-analyse one row with a comment.
   *
   * ⚠️ SPENDS MODEL CREDIT — one call per topic, on the question only. Which is
   * why the button says how many it is about to analyse.
   */
  const runAnalyse = async (opts: { topicIds?: number[]; comment?: string } = {}) => {
    const one = opts.topicIds?.length === 1 ? opts.topicIds[0] : null;
    setBusy(one !== null ? `analyse:${one}` : 'analyse');
    setError(null);
    setAnalyseResult(null);
    try {
      const res = await apiPost<AnalyseResult>(`/api/projects/${projectId}/shopify/analyse`, {
        ...(opts.topicIds?.length ? { topicIds: opts.topicIds } : {}),
        ...(opts.comment ? { comment: opts.comment } : {}),
      });
      setAnalyseResult(res);
      const [stored, analysed] = await Promise.all([
        apiGet<{ topics: StoredTopic[] }>(topicsUrl),
        apiGet<{ assessments: StoredAssessment[] }>(analyseUrl),
      ]);
      setTopics(stored.topics);
      setAssessments(analysed.assessments);
      if (one !== null) setOpen(one);
      else if (res.analysed > 0) setFilter('analysed');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Those topics could not be analysed.');
    } finally {
      setBusy(null);
    }
  };

  /**
   * Write a reply for one thread in one mode. THE MODE IS ON THE BUTTON.
   * This is the call that reads the replies.
   */
  const runDraft = async (topicId: number, mode: ReplyMode) => {
    setBusy(`draft:${topicId}:${mode}`);
    setError(null);
    try {
      const res = await apiPost<{ draft: { draftId: string } }>(`/api/projects/${projectId}/shopify/draft`, { topicId, mode });
      const [d, analysed] = await Promise.all([
        apiGet<DraftsResponse>(draftsUrl),
        apiGet<{ assessments: StoredAssessment[] }>(analyseUrl),
      ]);
      applyDrafts(d);
      setAssessments(analysed.assessments);
      setFreshDraftId(res.draft.draftId);
    } catch (err) {
      // The server's refusals say what to do next. Shown verbatim.
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
    // Optimistic; reconciled from the server if the write fails.
    setTopics((prev) => prev.map((t) => (ids.includes(t.id) ? { ...t, selected } : t)));
    try {
      await apiFetch<{ changed: number }>(`/api/projects/${projectId}/shopify/topics`, {
        method: 'PATCH',
        body: JSON.stringify({ topicIds: ids, selected }),
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That selection was not saved.');
      setTopics((await apiGet<{ topics: StoredTopic[] }>(topicsUrl)).topics);
    }
  };

  const byId = useMemo(() => new Map(catalogue.map((c) => [c.id, c])), [catalogue]);
  const assessmentByTopic = useMemo(() => new Map(assessments.map((a) => [a.topicId, a])), [assessments]);
  const draftsByTopic = useMemo(() => {
    const m = new Map<number, Draft[]>();
    for (const d of drafts) m.set(d.topicId, [...(m.get(d.topicId) ?? []), d]);
    return m;
  }, [drafts]);
  const sourceTitles = useMemo(() => new Map(sources.map((s) => [s.sourceId, s.title])), [sources]);
  // Not "deleted": drafts written before Shopify had its own list point at the
  // project-level store Reddit uses, and those sources still exist there.
  const sourceTitle = useCallback((id: string) => sourceTitles.get(id) ?? 'a source not in this list', [sourceTitles]);
  const selectedBoards = useMemo(() => new Set((config?.categories ?? []).map((c) => c.id)), [config]);

  const brandOpportunity = useCallback(
    (id: number) => {
      const a = assessmentByTopic.get(id);
      return !!a && isBrandOpportunity(a.current.assessment, a.current.brandSupported);
    },
    [assessmentByTopic],
  );

  /** The mode being written for this thread right now, from `busy`. */
  const writingFor = (topicId: number): ReplyMode | null => {
    const m = busy?.match(/^draft:(\d+):(\w+)$/);
    return m && Number(m[1]) === topicId ? (m[2] as ReplyMode) : null;
  };

  /** Whether this ROW can draft this mode, and if not, why. Brand is per row
   *  now — the analysis matched sources against this question. */
  const modeBlock = (mode: ReplyMode, a: StoredAssessment): string | null => {
    if (mode === 'open') return null;
    if (!hasClient) return 'Add client details first — see the Client details tab.';
    if (mode === 'growth') return null;
    if (!canNameClient) return 'Fill in "What they sell" on Client details before a reply may name the client.';
    if (!a.current.brandSupported) {
      return 'No knowledge source matched this question when it was analysed. Add one on the Knowledge tab, then re-analyse.';
    }
    return null;
  };

  const visible = useMemo(() => {
    const analysed = (id: number) => assessmentByTopic.has(id);
    const rows =
      filter === 'drafted'
        ? topics.filter((t) => draftsByTopic.has(t.id))
        : filter === 'analysed'
          ? topics.filter((t) => analysed(t.id))
          : filter === 'brand'
            ? topics.filter((t) => brandOpportunity(t.id))
            : filter === 'worth'
              ? topics.filter((t) => t.skipReasons.length === 0)
              : filter === 'selected'
                ? topics.filter((t) => t.selected)
                : filter === 'skipped'
                  ? topics.filter((t) => t.skipReasons.length > 0)
                  : topics;

    const score = (id: number) => {
      const a = assessmentByTopic.get(id)?.current.assessment;
      if (!a) return -1;
      return filter === 'brand' ? a.scores.brand.score : topScore(a);
    };
    return [...rows].sort((a, b) =>
      filter === 'analysed' || filter === 'brand'
        ? score(b.id) - score(a.id) || (b.lastPostedAtMs ?? 0) - (a.lastPostedAtMs ?? 0)
        : (b.lastPostedAtMs ?? 0) - (a.lastPostedAtMs ?? 0),
    );
  }, [topics, filter, assessmentByTopic, draftsByTopic, brandOpportunity]);

  const counts = useMemo(
    () => ({
      worth: topics.filter((t) => t.skipReasons.length === 0).length,
      selected: topics.filter((t) => t.selected).length,
      analysed: topics.filter((t) => assessmentByTopic.has(t.id)).length,
      brand: topics.filter((t) => brandOpportunity(t.id)).length,
      drafted: topics.filter((t) => draftsByTopic.has(t.id)).length,
      skipped: topics.filter((t) => t.skipReasons.length > 0).length,
      all: topics.length,
    }),
    [topics, assessmentByTopic, draftsByTopic, brandOpportunity],
  );

  const allVisiblePicked = visible.length > 0 && visible.every((t) => t.selected);

  return (
    <>
      <PageHeader
        title="Shopify Community"
        description="Pick threads by title. The AI analyses the question and says which kind of reply fits; it reads the replies only when you ask for a draft."
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
            {/* Says the number BEFORE it is pressed — one model call per topic. */}
            <button
              className="btn btn-primary btn-sm"
              onClick={() => void runAnalyse()}
              disabled={!!busy || counts.selected === 0}
              title="One request to the community and one model call per topic — the question only, not the replies"
            >
              <BookOpen size={14} /> {busy === 'analyse' ? 'Analysing…' : `Analyse ${counts.selected || ''} picked`}
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
        {(Object.keys(TAB_LABEL) as Tab[]).map((t) => (
          <button
            key={t}
            className={`tab ${tab === t ? 'active' : ''}`}
            onClick={() => setTab(t)}
            style={{ background: 'none', border: 'none', cursor: 'pointer' }}
          >
            {TAB_LABEL[t]}
            {t === 'knowledge' && <span className="chip-count">{sources.length}</span>}
          </button>
        ))}
      </div>

      {result && (
        <div className="alert alert-info">
          <div>
            Read <strong>{result.categories.reduce((n, c) => n + c.read, 0)}</strong> topics from{' '}
            {result.categories.length} board{result.categories.length === 1 ? '' : 's'} in {result.requests} request
            {result.requests === 1 ? '' : 's'}
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

      {analyseResult && (
        <div className="alert alert-info">
          <div>
            Analysed <strong>{analyseResult.analysed}</strong> question{analyseResult.analysed === 1 ? '' : 's'}.
            {analyseResult.skippedAsFresh > 0 &&
              ` ${analyseResult.skippedAsFresh} already analysed at this prompt version — use Re-analyse on a row to redo one.`}
            {analyseResult.notReached > 0 && ` ${analyseResult.notReached} not reached (per-run cap).`}
            {analyseResult.unreadable > 0 && ` ${analyseResult.unreadable} came back unreadable.`}
          </div>
          {analyseResult.message && <div className="small text-dim">{analyseResult.message}</div>}
          {analyseResult.failed.length > 0 && (
            <ul className="small" style={{ marginTop: '0.4rem' }}>
              {analyseResult.failed.map((f) => (
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
              {FILTERS.map((f) => (
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
                    : filter === 'brand'
                      ? 'No brand opportunities yet. Analyse some threads — and make sure the Knowledge tab has sources, or Brand is capped low.'
                      : 'Nothing here. Try another filter.'}
                </p>
              </div>
            ) : (
              <ul className="list">
                {visible.map((t) => {
                  const a = assessmentByTopic.get(t.id);
                  const rowDrafts = draftsByTopic.get(t.id) ?? [];
                  return (
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
                          <div className="row" style={{ justifyContent: 'space-between', gap: '1rem', flexWrap: 'nowrap', alignItems: 'flex-start' }}>
                            <strong style={{ minWidth: 0 }}>{t.title || 'Untitled topic'}</strong>
                            <div className="row" style={{ flexShrink: 0, gap: '0.35rem' }}>
                              {t.hasAcceptedAnswer && <span className="badge">solved</span>}
                              {rowDrafts.length > 0 && <span className="badge">drafted</span>}
                            </div>
                          </div>

                          {t.excerpt && (
                            <p className="small text-dim" style={{ margin: '0.2rem 0 0' }}>
                              {t.excerpt}
                            </p>
                          )}

                          {/* `replies` is derived from posts_count — Discourse's
                              reply_count is not the number of replies. */}
                          <div className="row small text-dim" style={{ flexWrap: 'wrap', gap: '0.75rem', marginTop: '0.3rem' }}>
                            <span>
                              <MessagesSquare size={12} aria-hidden /> {t.replies} {t.replies === 1 ? 'reply' : 'replies'}
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

                          {/* THE LIST STAYS COMPACT: scores and one control. Drafting
                              happens on the cards inside, next to the reason for
                              each kind of reply — not from the list, before the
                              reason has been read. */}
                          <div className="row" style={{ gap: '0.5rem', marginTop: '0.4rem', flexWrap: 'wrap' }}>
                            {a ? (
                              <>
                                {open !== t.id && <ScoreChips a={a.current.assessment} />}
                                <button
                                  className={`btn btn-sm ${open === t.id ? 'btn-ghost' : 'btn-secondary'}`}
                                  onClick={() => setOpen(open === t.id ? null : t.id)}
                                  aria-expanded={open === t.id}
                                >
                                  {open === t.id ? <ChevronUp size={13} /> : <ChevronDown size={13} />}{' '}
                                  {open === t.id
                                    ? 'Close'
                                    : rowDrafts.length
                                      ? `Review · ${rowDrafts.length} draft${rowDrafts.length === 1 ? '' : 's'}`
                                      : 'Review'}
                                </button>
                              </>
                            ) : (
                              <button
                                className="btn btn-secondary btn-sm"
                                onClick={() => void runAnalyse({ topicIds: [t.id] })}
                                disabled={!!busy}
                                title="One model call, on the question only"
                              >
                                <BookOpen size={13} /> {busy === `analyse:${t.id}` ? 'Analysing…' : 'Analyse this'}
                              </button>
                            )}
                          </div>

                          {open === t.id && a && (
                            <ThreadDetail
                              key={t.id}
                              stored={a}
                              drafts={rowDrafts}
                              writing={writingFor(t.id)}
                              reanalysing={busy === `analyse:${t.id}`}
                              anyBusy={!!busy}
                              freshDraftId={freshDraftId}
                              blockReason={(m) => modeBlock(m, a)}
                              sourceTitle={sourceTitle}
                              onDraft={(m) => runDraft(t.id, m)}
                              onReanalyse={(comment) => runAnalyse({ topicIds: [t.id], comment })}
                              onDecide={decide}
                              posting={postingProps}
                            />
                          )}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>
      )}

      {tab === 'client' && config && (
        <ClientTab
          projectId={projectId}
          client={config.client}
          onSaved={(c) => {
            setConfig({ ...config, client: c });
            setHasClient(c.companyDescription.trim().length > 0);
            setCanNameClient(c.companyDescription.trim().length > 0 && c.productService.trim().length > 0);
          }}
          onError={setError}
        />
      )}

      {tab === 'knowledge' && config && <KnowledgeTab projectId={projectId} client={config.client} onSources={setSources} />}

      {tab === 'settings' && config && (
        <SettingsTab
          projectId={projectId}
          posting={posting}
          onShopifyDryRun={setShopifyDryRun}
          config={config}
          catalogue={catalogue}
          catalogueError={catalogueError}
          sorts={sorts}
          selectedIds={selectedBoards}
          busy={busy === 'config'}
          onSave={saveConfig}
        />
      )}
    </>
  );
}

function SettingsTab({
  projectId,
  posting,
  onShopifyDryRun,
  config,
  catalogue,
  catalogueError,
  sorts,
  selectedIds,
  busy,
  onSave,
}: {
  projectId: string;
  posting: PostingContext | null;
  onShopifyDryRun: (dryRun: boolean) => void | Promise<void>;
  config: ShopifyModuleConfig;
  catalogue: ShopifyCategory[];
  catalogueError: string | null;
  sorts: SortMeta[];
  selectedIds: Set<number>;
  busy: boolean;
  onSave: (next: ShopifyModuleConfig) => void | Promise<void>;
}) {
  const toggle = (cat: ShopifyCategory) => {
    const next = selectedIds.has(cat.id) ? config.categories.filter((c) => c.id !== cat.id) : [...config.categories, cat];
    void onSave({ ...config, categories: next });
  };

  const planned = config.categories.length * config.pagesPerCategory;

  return (
    <div className="sections">
      {/* SHOPIFY'S OWN DRY-RUN SWITCH. Separate from Reddit's on purpose: a
          platform whose posting path is new must not inherit Reddit being live.
          Anything but an explicit "live" here is dry run, agent-side too. */}
      <section className="card">
        <div className="card-head">
          <h3>
            <Send size={16} aria-hidden /> Posting to the Shopify Community
          </h3>
          {posting && (
            <span className={`badge ${posting.dryRun ? 'badge-warning' : 'badge-success'}`}>
              {posting.dryRun ? 'Dry run — types, never submits' : 'Live — replies are submitted'}
            </span>
          )}
        </div>
        <p className="text-dim small">
          An approved draft is queued from its thread. The local agent opens the account&apos;s AdsPower profile, browses to
          the thread, checks the signed-in user, and types the reply. In dry run it stops there and empties the composer.
          This switch affects Shopify only; Reddit keeps its own on the Accounts page.
        </p>
        {posting?.agentRefusal && <p className="small" style={{ color: 'var(--warning)' }}>{posting.agentRefusal}</p>}
        <div className="row" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
          {posting && (
            <button
              className={`btn btn-sm ${posting.dryRun ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => {
                if (posting.dryRun && !confirm('Turn Shopify posting LIVE? Queued and new Shopify replies will be submitted to the forum.')) return;
                void onShopifyDryRun(!posting.dryRun);
              }}
            >
              {posting.dryRun ? 'Go live on Shopify' : 'Back to dry run'}
            </button>
          )}
          <span className="small text-dim">
            {posting ? `${posting.accounts.length} Shopify account${posting.accounts.length === 1 ? '' : 's'}` : 'Loading…'} ·{' '}
            <Link href="/accounts">manage accounts</Link>
          </span>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h3>
            <Cpu size={16} aria-hidden /> AI models
          </h3>
        </div>
        <p className="text-dim small">
          Which model scores a question and which writes a reply — for this module, on this project. The list is every
          model the product knows; the ones your keys cannot reach are greyed out with the reason. Add or share keys on{' '}
          <a href="/settings/api-keys">Settings → API keys</a>. A cheap, fast model is usually enough to score questions;
          the draft is where a stronger one earns its cost.
        </p>
        <ModelPicker
          projectId={projectId}
          analysisModel={config.analysisModel}
          draftModel={config.draftModel}
          draftNeedsJson
          onChange={(patch) => void onSave({ ...config, ...patch })}
        />
      </section>

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
              onChange={(e) => void onSave({ ...config, limits: { ...config.limits, quietAfterDays: Number(e.target.value) } })}
            />
          </div>
        </div>

        <p className="text-dim small">
          {sorts.find((s) => s.id === config.sort)?.help}{' '}
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
              On, a solved question never reaches the queue. Off, they stay in view — poor places to add to, good places to
              learn what this board accepts as an answer.
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
                <input type="checkbox" checked={selectedIds.has(cat.id)} disabled={busy} onChange={() => toggle(cat)} />
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
