'use client';

import { use, useEffect, useMemo, useRef, useState } from 'react';
import {
  RefreshCw,
  Sparkles,
  PenLine,
  Copy,
  ExternalLink,
  Search,
  Square,
  Star,
  RotateCw,
  CheckCircle2,
  X,
  EyeOff,
  Undo2,
  Check,
  Send,
  Footprints,
} from 'lucide-react';
import PageHeader from '@/components/PageHeader';
import DraftEditor from '@/components/DraftEditor';
import { apiPost, apiPatch, ApiError } from '@/lib/api';
import { subscribe, subscribeDoc, q, path } from '@/lib/data';
import { useAuth } from '@/lib/context/AuthContext';
import { accountPostGate } from '@/modules/reddit/accountGate';
import { MODELS } from '@/lib/llm/catalog';
import type { RedditModuleConfig } from '@/lib/types';
import { DRAFT_REASON_TAGS, DRAFT_REASON_LABELS, type DraftReasonTag, type RedditAccountStatus } from '@/modules/reddit/types';
import ApproachPlanView from '@/components/ApproachPlanView';
import {
  normalizeApproachPlan,
  normalizeApproachTrace,
  type ApproachPlan,
  type ApproachTrace,
} from '@/modules/reddit/approach';

// The review queue: fetch, analyse, draft, read, and the day-to-day curation
// around it — favourite, skip, re-analyse, mark posted, reject.
//
// Thresholds and filter names are ported from ML Studio so the same posts land
// in the same buckets — parity is judged on this screen. The difference from ML
// Studio is invisible here: every mutation goes to a permission-gated server
// route, not a client-side updateDoc. Reads stay live (onSnapshot), so a write
// shows up when the server commits it.

const GROWTH_MIN = 40;
const QUALITY_FLOOR: Record<string, number> = { any: 0, best: 75, good: 60, okay: 40 };

// 0.8-1.5s jittered gap between subreddits. Reddit rate-limits per IP, and a
// regular cadence looks more like a script than a person.
const RSS_GAP_MIN_MS = 800;
const RSS_GAP_JITTER_MS = 700;

// Per-project cutoff for the NEW badge. localStorage, like ML Studio: this is a
// personal "what have I already looked at" marker, not shared project state.
/** Turn a stored provider model id into something readable.
 *
 *  Rows store the PROVIDER's id ("anthropic/claude-opus-5", "deepseek-chat")
 *  rather than our namespaced ref, so that a DeepSeek row written before model
 *  selection existed still reads the same and stays comparable with history.
 *  That means matching on the tail rather than the whole ref. */
function modelLabel(model: string): string {
  if (!model) return 'model unknown';
  const hit = MODELS.find((m) => m.providerModelId === model);
  return hit ? hit.label : model;
}

const lastSeenKey = (projectId: string) => `motherlink-engage:reddit:lastSeen:${projectId}`;

interface Draft {
  draftId: string;
  body: string;
  status: string;
  promptVersion: string;
  /** Which model wrote it. Absent on rows written before model selection
   *  existed — those were all DeepSeek, but we say "unknown" rather than
   *  back-fill an assumption into a provenance field. */
  model: string;
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
  model: string;
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
  fetchedAtMs: number;
  processingStatus: string;
  isFavorite: boolean;
  analysis: Analysis | null;
  drafts: Draft[];
}

type Filter = 'brand' | 'growth' | 'unanalyzed' | 'all' | 'archived';

/** Optimistic overlay for a curation write that is still in flight. Reads are
 *  live, so the real value lands via onSnapshot a few hundred ms later; until
 *  then this keeps the star (or the dismiss) feeling instant. */
type Override = { isFavorite?: boolean; processingStatus?: string };

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
const isArchived = (i: Item) => i.processingStatus === 'archived';

export default function OpportunitiesPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = use(params);
  const { profile } = useAuth();

  // Reads come straight from Firestore, live. No server round-trip, local
  // cache, and the list updates in real time as fetch/analyze/draft write —
  // so a running Analyse loop fills the screen as it goes, with no polling.
  const [rawItems, setRawItems] = useState<Record<string, unknown>[] | null>(null);
  const [rawAnalyses, setRawAnalyses] = useState<Record<string, unknown>[]>([]);
  const [rawDrafts, setRawDrafts] = useState<Record<string, unknown>[]>([]);
  const [rawAccounts, setRawAccounts] = useState<Record<string, unknown>[]>([]);
  const [rawJobs, setRawJobs] = useState<Record<string, unknown>[]>([]);
  const [config, setConfig] = useState<RedditModuleConfig | null>(null);
  // Which draft's "post from…" account picker is open.
  const [pickerDraft, setPickerDraft] = useState<string | null>(null);
  // Which draft's read-only approach plan is expanded.
  const [planDraft, setPlanDraft] = useState<string | null>(null);

  const [filter, setFilter] = useState<Filter>('brand');
  const [floor, setFloor] = useState<keyof typeof QUALITY_FLOOR>('any');
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  // Optimistic curation overlay, keyed by itemId. Cleared once the live
  // subscription reports the same value the server wrote (see the effect below).
  const [overrides, setOverrides] = useState<Record<string, Override>>({});

  // NEW badge cutoff (epoch ms). 0 until we know it.
  const [lastSeenCutoff, setLastSeenCutoff] = useState(0);

  // Inline reject-with-notes form: the draft being rejected, and the note text.
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [rejectNote, setRejectNote] = useState('');
  const [rejectTags, setRejectTags] = useState<Set<DraftReasonTag>>(new Set());

  // Which draft is open in the inline editor.
  const [editing, setEditing] = useState<string | null>(null);

  // The caller's own permissions on this project, so we can show the
  // reason/training UI only to drafts.train holders. Platform admins hold every
  // permission implicitly. This is presentation only — the server re-checks.
  const [myPermissions, setMyPermissions] = useState<string[]>([]);
  const isPlatformAdmin = profile?.role === 'owner' || profile?.role === 'admin';
  const canTrain = isPlatformAdmin || myPermissions.includes('drafts.train');

  // Feedback from the last keyword search: the exact query Reddit was sent, and
  // how many posts each subreddit returned. Null unless the last run was a search.
  const [lastSearch, setLastSearch] = useState<{ query: string; hits: Record<string, number> } | null>(null);

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
      subscribe<Record<string, unknown>>(q.accounts(), setRawAccounts, onErr),
      subscribe<Record<string, unknown>>(q.jobs(projectId), setRawJobs, onErr),
      subscribeDoc<RedditModuleConfig>(path.redditConfig(projectId), (c) => setConfig(c ?? null), onErr),
    ];
    return () => unsub.forEach((u) => u());
  }, [projectId]);

  // The caller's own membership doc — live, so a permission grant applies without
  // a reload. Rules allow reading your own member doc (resource.data.uid == uid).
  useEffect(() => {
    if (!profile?.uid) return;
    return subscribeDoc<{ permissions?: string[] }>(
      ['projects', projectId, 'members', profile.uid],
      (m) => setMyPermissions(m?.permissions ?? []),
    );
  }, [projectId, profile?.uid]);

  // Load the NEW-badge cutoff once per project.
  useEffect(() => {
    const raw = localStorage.getItem(lastSeenKey(projectId));
    setLastSeenCutoff(raw ? Number(raw) || 0 : 0);
  }, [projectId]);

  const ms = (v: unknown): number =>
    v && typeof v === 'object' && 'toMillis' in v ? (v as { toMillis(): number }).toMillis() : 0;
  const isoOf = (v: unknown): string | null =>
    v && typeof v === 'object' && 'toDate' in v ? (v as { toDate(): Date }).toDate().toISOString() : null;

  // Once the real data catches up to an optimistic override, drop the override
  // so it stops shadowing the source of truth.
  useEffect(() => {
    if (!rawItems) return;
    setOverrides((prev) => {
      if (Object.keys(prev).length === 0) return prev;
      const next = { ...prev };
      let changed = false;
      for (const raw of rawItems) {
        const id = raw.id as string;
        const o = next[id];
        if (!o) continue;
        const favMatch = o.isFavorite === undefined || o.isFavorite === Boolean(raw.isFavorite);
        const statusMatch =
          o.processingStatus === undefined || o.processingStatus === (raw.processingStatus as string);
        if (favMatch && statusMatch) {
          delete next[id];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [rawItems]);

  // Join items + latest analysis + drafts, exactly as the server route did,
  // but derived from the live subscriptions. Optimistic overrides win.
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
        const o = overrides[id] ?? {};
        return {
          itemId: id,
          externalId: i.externalId as string,
          subreddit: i.subreddit as string,
          title: i.title as string,
          body: i.body as string,
          author: i.author as string,
          permalink: i.permalink as string,
          createdAtSource: isoOf(i.createdAtSource),
          fetchedAtMs: ms(i.fetchedAt),
          processingStatus: o.processingStatus ?? (i.processingStatus as string),
          isFavorite: o.isFavorite ?? Boolean(i.isFavorite),
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
                model: (a.model as string) ?? '',
              }
            : null,
          drafts: (byItem.get(id) ?? []).map((d) => ({
            draftId: d.draftId as string,
            body: d.body as string,
            status: d.status as string,
            promptVersion: d.promptVersion as string,
            model: (d.model as string) ?? '',
          })),
        } satisfies Item;
      })
      .sort((a, b) => (b.createdAtSource ?? '').localeCompare(a.createdAtSource ?? ''));
  }, [rawItems, rawAnalyses, rawDrafts, overrides]);

  // The ANSWERED ledger: any post that has ever had a draft marked posted.
  // Survives history cleanup because posted drafts are retained, so a re-fetched
  // post still reads as answered.
  const answeredItemIds = useMemo(
    () => new Set(rawDrafts.filter((d) => d.status === 'posted').map((d) => d.itemId as string)),
    [rawDrafts],
  );

  // Posting identities for the account picker, with the fields the rate gate
  // needs. The gate itself is computed at render time (it depends on "now").
  const accounts = useMemo(
    () =>
      rawAccounts
        .map((a) => ({
          accountId: a.id as string,
          label: (a.label as string) ?? '',
          username: (a.username as string) ?? '',
          adsPowerProfileId: (a.adsPowerProfileId as string) ?? '',
          gateInput: {
            status: (a.status as RedditAccountStatus) ?? 'warming',
            dailyCap: (a.dailyCap as number) ?? 0,
            minIntervalMinutes: (a.minIntervalMinutes as number) ?? 0,
            postCountToday: (a.postCountToday as number) ?? 0,
            postCountResetAtMs: ms(a.postCountResetAt),
            lastPostAtMs: ms(a.lastPostAt),
          },
        }))
        .sort((x, y) => x.label.localeCompare(y.label)),
    [rawAccounts],
  );

  // Latest job per draft, so a draft can show its live posting status.
  const jobByDraft = useMemo(() => {
    const m = new Map<
      string,
      {
        jobId: string;
        status: string;
        error?: string;
        permalink?: string;
        at: number;
        approachPlan: ApproachPlan;
        approachTrace: ApproachTrace;
      }
    >();
    for (const j of rawJobs) {
      const key = j.draftId as string;
      const at = ms(j.createdAt);
      const prev = m.get(key);
      if (!prev || at > prev.at) {
        m.set(key, {
          jobId: (j.jobId as string) || (j.id as string),
          status: j.status as string,
          error: j.error as string | undefined,
          permalink: j.permalink as string | undefined,
          at,
          // Jobs queued before approach plans existed simply have none — the
          // agent composes its own fallback, and we show nothing here.
          approachPlan: normalizeApproachPlan(j.approachPlan),
          // Written back by the agent once the job has run — what actually
          // happened, kept permanently next to the plan.
          approachTrace: normalizeApproachTrace(j.approachTrace),
        });
      }
    }
    return m;
  }, [rawJobs]);

  const isNew = (i: Item) => lastSeenCutoff > 0 && i.fetchedAtMs > lastSeenCutoff;

  /** On the first fetch of a fresh project, plant a cutoff just behind now so the
   *  incoming posts read as NEW. After that the cutoff only moves on Mark seen. */
  function ensureCutoffBaseline() {
    if (localStorage.getItem(lastSeenKey(projectId))) return;
    const baseline = Date.now() - 5000; // 5s skew buffer
    localStorage.setItem(lastSeenKey(projectId), String(baseline));
    setLastSeenCutoff(baseline);
  }

  function markAllSeen() {
    const now = Date.now();
    localStorage.setItem(lastSeenKey(projectId), String(now));
    setLastSeenCutoff(now);
  }

  async function runFetch(mode: 'new' | 'search') {
    if (!config?.targetSubreddits.length) {
      setError('Add at least one subreddit in Settings first.');
      return;
    }
    if (mode === 'search' && !config.keywords.length) {
      setError('Search needs keywords. Add some in Settings.');
      return;
    }

    ensureCutoffBaseline();
    stop.current = false;
    setError(null);
    setBusy(mode === 'search' ? 'search' : 'fetch');
    // A fresh search replaces the old feedback; a plain fetch clears it.
    setLastSearch(null);

    let created = 0;
    const subs = config.targetSubreddits;

    // Search feedback, accumulated across the per-subreddit requests.
    const searchHits: Record<string, number> = {};
    let searchQuery = '';

    // Accumulated across the whole cycle so the purge at the end reconciles once
    // (like ML Studio) instead of per request: which item ids are fresh, and
    // which subreddits actually returned posts (only those are purge candidates,
    // so an errored or empty subreddit's history is never wiped).
    const keepItemIds: string[] = [];
    const successfulSubs: string[] = [];

    // One subreddit per request, jittered. The server throttles internally too,
    // but pacing here keeps the UI honest about progress and lets stop work.
    for (let i = 0; i < subs.length; i++) {
      if (stop.current) break;
      setProgress(`r/${subs[i]} (${i + 1}/${subs.length})`);
      try {
        const r = await apiPost<{
          posts: { redditPostId: string }[];
          saved: { created: number };
          errors: { message: string }[];
          hitsBySubreddit?: Record<string, number>;
          query?: string | null;
        }>(`/api/projects/${projectId}/reddit/fetch`, {
          mode,
          subreddits: [subs[i]],
          keywords: config.keywords,
          limit: 25,
        });
        created += r.saved?.created ?? 0;
        if (r.posts?.length) {
          successfulSubs.push(subs[i]);
          for (const p of r.posts) keepItemIds.push(`${projectId}_${p.redditPostId}`);
        }
        if (mode === 'search') {
          if (r.query) searchQuery = r.query;
          searchHits[subs[i]] = r.hitsBySubreddit?.[subs[i]] ?? 0;
        }
        if (r.errors?.length) setError(`r/${subs[i]}: ${r.errors[0].message}`);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Fetch failed.');
        break;
      }
      if (i < subs.length - 1 && !stop.current) {
        await new Promise((r) => setTimeout(r, RSS_GAP_MIN_MS + Math.random() * RSS_GAP_JITTER_MS));
      }
    }

    // Reconcile: drop stale items from the subreddits we refreshed. Favourites
    // and answered posts survive (enforced server-side). Best-effort — a purge
    // failure must not present the fetch itself as failed.
    let purged: { deletedItems: number; keptFavorites: number } | null = null;
    if (successfulSubs.length > 0) {
      try {
        purged = await apiPost(`/api/projects/${projectId}/reddit/purge`, {
          keepItemIds,
          onlySubreddits: successfulSubs,
        });
      } catch {
        // Leave the fetch result standing; the stale items simply remain.
      }
    }

    if (mode === 'search' && searchQuery) {
      setLastSearch({ query: searchQuery, hits: searchHits });
    }

    setProgress(null);
    setBusy(null);
    // No reload: the items subscription reflects the new posts as they land.
    if (!error) {
      const cleared = purged?.deletedItems
        ? ` · ${purged.deletedItems} cleared${purged.keptFavorites ? ` (kept ${purged.keptFavorites} ★)` : ''}`
        : '';
      setProgress(`${created} new post${created === 1 ? '' : 's'}${cleared}.`);
    }
  }

  async function analyzeAll() {
    const todo = (items ?? []).filter((i) => !i.analysis && !isArchived(i));
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

  async function reanalyze(item: Item) {
    setBusy(`re:${item.itemId}`);
    setError(null);
    try {
      // Same route as the first pass: it writes a NEW analysis rather than
      // mutating the old one, and the join above takes the latest per item.
      await apiPost(`/api/projects/${projectId}/reddit/analyze`, { itemId: item.itemId });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Re-analysis failed.');
    } finally {
      setBusy(null);
    }
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

  async function toggleFavorite(item: Item) {
    const next = !item.isFavorite;
    setOverrides((o) => ({ ...o, [item.itemId]: { ...o[item.itemId], isFavorite: next } }));
    setError(null);
    try {
      await apiPatch(`/api/projects/${projectId}/reddit/items`, { itemId: item.itemId, isFavorite: next });
    } catch (err) {
      // Roll the overlay back to what it was.
      setOverrides((o) => ({ ...o, [item.itemId]: { ...o[item.itemId], isFavorite: item.isFavorite } }));
      setError(err instanceof ApiError ? err.message : 'Could not update favourite.');
    }
  }

  async function setStatus(item: Item, processingStatus: string) {
    setOverrides((o) => ({ ...o, [item.itemId]: { ...o[item.itemId], processingStatus } }));
    setError(null);
    try {
      await apiPatch(`/api/projects/${projectId}/reddit/items`, { itemId: item.itemId, processingStatus });
    } catch (err) {
      setOverrides((o) => ({
        ...o,
        [item.itemId]: { ...o[item.itemId], processingStatus: item.processingStatus },
      }));
      setError(err instanceof ApiError ? err.message : 'Could not update this post.');
    }
  }

  const skip = (item: Item) => setStatus(item, 'archived');
  const unarchive = (item: Item) => setStatus(item, item.analysis ? 'analyzed' : 'fetched');

  async function publish(draftId: string, accountId: string) {
    setBusy(draftId);
    setError(null);
    try {
      await apiPost(`/api/projects/${projectId}/reddit/jobs`, { draftId, accountId });
      setPickerDraft(null);
      // The jobs subscription reflects the new "queued" status on the draft.
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not queue the reply.');
    } finally {
      setBusy(null);
    }
  }

  async function cancelPost(draftId: string, jobId: string) {
    setBusy(draftId);
    setError(null);
    try {
      await apiPost(`/api/projects/${projectId}/reddit/jobs/cancel`, { jobId });
      // The jobs subscription clears the queued/posting status; the draft frees up.
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not cancel the reply.');
    } finally {
      setBusy(null);
    }
  }

  async function markPosted(d: Draft) {
    setBusy(d.draftId);
    setError(null);
    try {
      await apiPatch(`/api/projects/${projectId}/reddit/draft`, { draftId: d.draftId, status: 'posted' });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not mark posted.');
    } finally {
      setBusy(null);
    }
  }

  async function confirmReject(d: Draft) {
    setBusy(d.draftId);
    setError(null);
    try {
      // Route through the feedback endpoint so a train holder's rejection reason
      // (tags + note) is captured as training signal — "never write it this way".
      // Non-train users still reject with a note; nothing is captured.
      await apiPost(`/api/projects/${projectId}/reddit/draft/feedback`, {
        draftId: d.draftId,
        kind: 'reject',
        reasonText: rejectNote.trim(),
        reasonTags: canTrain ? [...rejectTags] : [],
      });
      setRejecting(null);
      setRejectNote('');
      setRejectTags(new Set());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reject the draft.');
    } finally {
      setBusy(null);
    }
  }

  function toggleRejectTag(t: DraftReasonTag) {
    setRejectTags((s) => {
      const n = new Set(s);
      if (n.has(t)) n.delete(t);
      else n.add(t);
      return n;
    });
  }

  async function copy(d: Draft) {
    await navigator.clipboard.writeText(d.body);
    setCopied(d.draftId);
    setTimeout(() => setCopied(null), 1600);
  }

  const shown = useMemo(() => {
    const min = QUALITY_FLOOR[floor];
    const all = items ?? [];
    if (filter === 'archived') return all.filter(isArchived);
    const active = all.filter((i) => !isArchived(i));
    return active.filter((i) => {
      if (filter === 'unanalyzed') return !i.analysis;
      if (filter === 'all') return true;
      if (!i.analysis) return false;
      if (filter === 'brand') return isBrand(i.analysis) && i.analysis.score >= min;
      return isGrowth(i.analysis) && (i.analysis.growthScore ?? 0) >= min; // growth
    });
  }, [items, filter, floor]);

  const counts = useMemo(() => {
    const all = items ?? [];
    const active = all.filter((i) => !isArchived(i));
    return {
      brand: active.filter((i) => i.analysis && isBrand(i.analysis)).length,
      growth: active.filter((i) => i.analysis && isGrowth(i.analysis)).length,
      unanalyzed: active.filter((i) => !i.analysis).length,
      all: active.length,
      archived: all.length - active.length,
    };
  }, [items]);

  const newCount = useMemo(
    () => (items ?? []).filter((i) => !isArchived(i) && isNew(i)).length,
    [items, lastSeenCutoff], // eslint-disable-line react-hooks/exhaustive-deps
  );

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

        {lastSearch && (
          <div className="card feedback">
            <div className="card-head">
              <span className="eyebrow-muted">Search feedback</span>
              <button className="btn btn-ghost btn-sm" onClick={() => setLastSearch(null)}>
                <X size={13} /> Dismiss
              </button>
            </div>
            <p className="small">
              <span className="eyebrow-muted">Query sent</span> <code>{lastSearch.query}</code>
            </p>
            <p className="small">
              <span className="eyebrow-muted">Hits per subreddit</span>{' '}
              {Object.entries(lastSearch.hits)
                .map(([sub, n]) => `r/${sub}: ${n}`)
                .join(' · ') || 'none'}
            </p>
          </div>
        )}

        <div className="row between">
          <div className="tabs-inline">
            {(['brand', 'growth', 'unanalyzed', 'all', 'archived'] as Filter[]).map((f) => (
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
          <div className="row">
            {newCount > 0 && (
              <button className="btn btn-ghost btn-sm" onClick={markAllSeen} title="Clear the NEW badges">
                <Check size={13} /> Mark {newCount} seen
              </button>
            )}
            {filter === 'brand' || filter === 'growth' ? (
              <select value={floor} onChange={(e) => setFloor(e.target.value as keyof typeof QUALITY_FLOOR)}>
                <option value="any">Any score</option>
                <option value="okay">40+ okay</option>
                <option value="good">60+ good</option>
                <option value="best">75+ best</option>
              </select>
            ) : null}
          </div>
        </div>

        {items === null && <p className="text-dim small">Loading…</p>}

        {items && shown.length === 0 && (
          <div className="card">
            <div className="empty">
              <p>Nothing here yet.</p>
              <p className="text-dim small">
                {counts.all === 0 && counts.archived === 0
                  ? 'Fetch some posts to get started.'
                  : filter === 'brand'
                    ? 'No brand opportunities at this score. Try Growth, or lower the floor.'
                    : filter === 'archived'
                      ? 'No skipped posts.'
                      : 'Nothing matches this filter.'}
              </p>
            </div>
          </div>
        )}

        {shown.map((item) => {
          const a = item.analysis;
          const kind = a ? (isBrand(a) ? 'brand' : isGrowth(a) ? 'growth' : null) : null;
          const archived = isArchived(item);
          const posted = item.drafts.filter((d) => d.status === 'posted');
          const active = item.drafts.filter((d) => d.status === 'draft');
          const answered = answeredItemIds.has(item.itemId);

          return (
            <article key={item.itemId} className="card">
              <div className="card-head">
                <div className="row">
                  <span className="badge badge-no-dot badge-solid">{`r/${item.subreddit}`}</span>
                  <span className="text-dim small">{age(item.createdAtSource)}</span>
                  <span className="text-faint small">u/{item.author}</span>
                  {isNew(item) && <span className="badge badge-success">NEW</span>}
                  {answered && <span className="badge badge-info">ANSWERED</span>}
                  {archived && <span className="badge">skipped</span>}
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
                  <button
                    className="btn btn-ghost btn-sm btn-icon"
                    onClick={() => toggleFavorite(item)}
                    aria-pressed={item.isFavorite}
                    title={
                      item.isFavorite
                        ? 'Favourited — kept when history is cleaned'
                        : 'Favourite to keep this post through a history clean'
                    }
                  >
                    <Star
                      size={15}
                      fill={item.isFavorite ? '#f5b301' : 'none'}
                      color={item.isFavorite ? '#f5b301' : 'currentColor'}
                    />
                  </button>
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
                    mention: {a.mentionRecommendation} · prompt {a.promptVersion} · {modelLabel(a.model)}
                    {a.growthScore === null && ' · pre-v3, no growth score'}
                  </p>
                </div>
              )}

              {posted.map((d) => (
                <div key={d.draftId} className="draft">
                  <div className="card-head">
                    <span className="eyebrow-muted">Posted reply</span>
                    <button className="btn btn-ghost btn-sm" onClick={() => copy(d)}>
                      <Copy size={13} /> {copied === d.draftId ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                  <p className="draft-body">{d.body}</p>
                </div>
              ))}

              {active.map((d) => (
                <div key={d.draftId} className="draft">
                  <div className="card-head">
                    <span className="eyebrow-muted">
                      Draft reply
                      <span className="text-faint" style={{ marginLeft: 8, fontWeight: 400, textTransform: 'none' }}>
                        {modelLabel(d.model)}
                      </span>
                    </span>
                    {editing !== d.draftId && (
                      <div className="row">
                        <button className="btn btn-ghost btn-sm" onClick={() => copy(d)}>
                          <Copy size={13} /> {copied === d.draftId ? 'Copied' : 'Copy'}
                        </button>
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => {
                            setEditing(d.draftId);
                            setRejecting(null);
                          }}
                          disabled={busy === d.draftId}
                          title="Edit this reply"
                        >
                          <PenLine size={13} /> Edit
                        </button>
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => markPosted(d)}
                          disabled={busy === d.draftId}
                          title="Record that this reply was posted by hand"
                        >
                          <CheckCircle2 size={13} /> Mark posted
                        </button>
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => {
                            setRejecting(d.draftId);
                            setRejectTags(new Set());
                            setRejectNote('');
                          }}
                          disabled={busy === d.draftId}
                        >
                          <X size={13} /> Reject
                        </button>
                      </div>
                    )}
                  </div>

                  {editing === d.draftId ? (
                    <DraftEditor
                      projectId={projectId}
                      draftId={d.draftId}
                      initialBody={d.body}
                      canTrain={canTrain}
                      onClose={() => setEditing(null)}
                      onSaved={() => setEditing(null)}
                    />
                  ) : (
                    <p className="draft-body">{d.body}</p>
                  )}

                  {rejecting === d.draftId && (
                    <div className="stack" style={{ marginTop: 8 }}>
                      {canTrain && (
                        <div className="de-tags">
                          {DRAFT_REASON_TAGS.map((t) => (
                            <button
                              key={t}
                              type="button"
                              className={`de-chip ${rejectTags.has(t) ? 'on' : ''}`}
                              onClick={() => toggleRejectTag(t)}
                            >
                              {DRAFT_REASON_LABELS[t]}
                            </button>
                          ))}
                        </div>
                      )}
                      <textarea
                        value={rejectNote}
                        onChange={(e) => setRejectNote(e.target.value)}
                        placeholder={
                          canTrain
                            ? 'Why is this being rejected? Captured to train the AI.'
                            : 'Why is this being rejected? (optional — kept on the record)'
                        }
                        rows={2}
                      />
                      <div className="row">
                        <button
                          className="btn btn-danger btn-sm"
                          onClick={() => confirmReject(d)}
                          disabled={busy === d.draftId}
                        >
                          {busy === d.draftId ? 'Rejecting…' : 'Confirm reject'}
                        </button>
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => setRejecting(null)}
                          disabled={busy === d.draftId}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}

                  {(() => {
                    const job = jobByDraft.get(d.draftId);
                    if (job?.status === 'queued' || job?.status === 'posting') {
                      return (
                        <div style={{ marginTop: 8 }}>
                          <div className="row between" style={{ gap: 8 }}>
                            <p className="text-muted small" style={{ margin: 0 }}>
                              <Send size={12} style={{ verticalAlign: '-2px' }} />{' '}
                              {job.status === 'queued' ? 'Queued for posting' : 'Posting…'}
                            </p>
                            <div className="row" style={{ gap: 8 }}>
                              {job.approachPlan.length > 0 && (
                                <button
                                  className="btn btn-ghost btn-sm"
                                  onClick={() => setPlanDraft(planDraft === d.draftId ? null : d.draftId)}
                                  title="See how this account will approach the post before replying"
                                >
                                  <Footprints size={12} />{' '}
                                  {planDraft === d.draftId ? 'Hide approach' : 'Approach'}
                                </button>
                              )}
                              <button
                                className="btn btn-ghost btn-sm"
                                onClick={() => cancelPost(d.draftId, job.jobId)}
                                disabled={busy === d.draftId}
                                title={
                                  job.status === 'queued'
                                    ? 'Remove this reply from the queue before it posts'
                                    : 'Stop this reply (only works if the agent has not already submitted it)'
                                }
                              >
                                <X size={12} /> {busy === d.draftId ? 'Cancelling…' : 'Cancel'}
                              </button>
                            </div>
                          </div>
                          {planDraft === d.draftId && (
                            <ApproachPlanView plan={job.approachPlan} trace={job.approachTrace} />
                          )}
                        </div>
                      );
                    }
                    if (job?.status === 'posted') {
                      return (
                        <div style={{ marginTop: 8 }}>
                          <div className="row between" style={{ gap: 8 }}>
                            <p className="text-success small" style={{ margin: 0 }}>
                              Posted{job.permalink ? ' · ' : ''}
                              {job.permalink && (
                                <a href={job.permalink} target="_blank" rel="noreferrer">
                                  view
                                </a>
                              )}
                            </p>
                            {(job.approachPlan.length > 0 || job.approachTrace.length > 0) && (
                              <button
                                className="btn btn-ghost btn-sm"
                                onClick={() => setPlanDraft(planDraft === d.draftId ? null : d.draftId)}
                                title="See the approach this reply was posted through"
                              >
                                <Footprints size={12} />{' '}
                                {planDraft === d.draftId ? 'Hide approach' : 'Approach'}
                              </button>
                            )}
                          </div>
                          {planDraft === d.draftId && (
                            <ApproachPlanView plan={job.approachPlan} trace={job.approachTrace} />
                          )}
                        </div>
                      );
                    }
                    const priorAttempt = job?.status === 'failed' || job?.status === 'cancelled';
                    return (
                      <div style={{ marginTop: 8 }}>
                        <div className="row">
                          {job?.status === 'failed' && (
                            <span className="text-error small">
                              Posting failed{job.error ? `: ${job.error}` : ''}.
                            </span>
                          )}
                          {job?.status === 'cancelled' && (
                            <span className="text-muted small">Cancelled before posting.</span>
                          )}
                          {priorAttempt && job && (job.approachPlan.length > 0 || job.approachTrace.length > 0) && (
                            <button
                              className="btn btn-ghost btn-sm"
                              onClick={() => setPlanDraft(planDraft === d.draftId ? null : d.draftId)}
                              title="See how far the last attempt got"
                            >
                              <Footprints size={12} />{' '}
                              {planDraft === d.draftId ? 'Hide approach' : 'Last approach'}
                            </button>
                          )}
                          <button
                            className="btn btn-secondary btn-sm"
                            onClick={() => setPickerDraft(pickerDraft === d.draftId ? null : d.draftId)}
                          >
                            <Send size={12} /> {priorAttempt ? 'Post again' : 'Publish'}
                          </button>
                        </div>
                        {priorAttempt && planDraft === d.draftId && job && (
                          <ApproachPlanView plan={job.approachPlan} trace={job.approachTrace} />
                        )}
                        {pickerDraft === d.draftId && (
                          <div className="bordered stack" style={{ marginTop: 8 }}>
                            <div className="row between">
                              <span className="eyebrow-muted">Post from…</span>
                              <button
                                className="btn btn-ghost btn-sm btn-icon"
                                onClick={() => setPickerDraft(null)}
                                aria-label="Close"
                              >
                                <X size={13} />
                              </button>
                            </div>
                            {accounts.length === 0 && (
                              <p className="text-dim small">No posting accounts yet — add one under Accounts.</p>
                            )}
                            {accounts.map((acc) => {
                              const gate = accountPostGate(acc.gateInput, Date.now());
                              const blocked = !gate.ok || !acc.adsPowerProfileId;
                              return (
                                <button
                                  key={acc.accountId}
                                  className="btn btn-secondary btn-sm"
                                  disabled={blocked || busy === d.draftId}
                                  onClick={() => publish(d.draftId, acc.accountId)}
                                  style={{ justifyContent: 'space-between' }}
                                >
                                  <span>
                                    {acc.label}{' '}
                                    {acc.username && <span className="text-faint">u/{acc.username}</span>}
                                  </span>
                                  <span className="text-dim small">
                                    {!acc.adsPowerProfileId
                                      ? 'no profile id'
                                      : gate.ok
                                        ? `${gate.remainingToday} left`
                                        : gate.reason}
                                  </span>
                                </button>
                              );
                            })}
                            <p className="text-faint small">
                              Queues the reply. It posts when the local posting agent is running (and
                              Dry run is off on the Accounts page); otherwise it waits in the queue.
                            </p>
                          </div>
                        )}
                      </div>
                    );
                  })()}
                </div>
              ))}

              <div className="row" style={{ marginTop: 4 }}>
                {a && kind && active.length === 0 && posted.length === 0 && (
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => draft(item)}
                    disabled={busy === item.itemId}
                  >
                    <PenLine size={13} /> {busy === item.itemId ? 'Writing…' : `Draft ${kind} reply`}
                  </button>
                )}

                {a && (
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => reanalyze(item)}
                    disabled={busy === `re:${item.itemId}`}
                    title="Score this post again against the current knowledge base"
                  >
                    <RotateCw size={13} className={busy === `re:${item.itemId}` ? 'spin' : ''} />{' '}
                    {busy === `re:${item.itemId}` ? 'Re-analysing…' : 'Re-analyse'}
                  </button>
                )}

                {archived ? (
                  <button className="btn btn-ghost btn-sm" onClick={() => unarchive(item)}>
                    <Undo2 size={13} /> Unskip
                  </button>
                ) : (
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => skip(item)}
                    title="Dismiss this post from the queue"
                  >
                    <EyeOff size={13} /> Skip
                  </button>
                )}
              </div>

              {a && !kind && active.length === 0 && posted.length === 0 && (
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
