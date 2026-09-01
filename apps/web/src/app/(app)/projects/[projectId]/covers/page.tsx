'use client';

import { use, useCallback, useEffect, useState } from 'react';
import {
  Download,
  ExternalLink,
  ChevronRight,
  ChevronDown,
  AlertTriangle,
  Clock,
  MessagesSquare,
  Eye,
  Layers,
  Filter,
  PenLine,
  Target,
  HelpCircle,
} from 'lucide-react';
import PageHeader from '@/components/PageHeader';
import CoversDraftReview from '@/components/CoversDraftReview';
import CoversPolicyTab from '@/components/CoversPolicyTab';
import CoversKnowledgeTab from '@/components/CoversKnowledgeTab';
import { apiGet, apiPost, apiFetch, ApiError } from '@/lib/api';
import { SECTION_ROLE_LABEL, type CoversSection, type SectionRole } from '@/modules/covers/sections';
import { OUTCOME_LABEL, type TriageOutcome } from '@/modules/covers/triage';
import { INTENT_LABEL, type PostIntent } from '@/modules/covers/intent';
import {
  OFF_DOMAIN_TOPIC_LABEL,
  type DomainEvidence,
  type DomainVerdict,
  type OffDomainTopic,
} from '@/modules/covers/domain';
import { SCREEN_REASON_LABEL, type ScreenReason } from '@/modules/covers/screen';
import { teamLabel } from '@/modules/covers/teams';
import type { CoversModuleConfig } from '@/modules/covers/config';
import type { CoversEntities } from '@/modules/covers/entities';

// Covers — the harvest.
//
// ════════════════════════════════════════════════════════════════════════════
// THIS SCREEN DELIBERATELY DOES NOT SCORE ANYTHING
//
// Phase 2 of the staged build reads Covers and shows what it read. No intent,
// no match, no ranking, no draft — those are phases 3 and 4, and there is no
// code in the tree that could post any of it before phase 6.
//
// The reason a harvest-only screen is worth building rather than skipping
// straight to a ranked queue: this is the first place a person can check that
// the reader is telling the truth. Wrong authors, four-hour-old timestamps that
// should be four hours older, a "fixture" made of two teams mentioned in
// passing — all of that is obvious here and invisible once a scorer has turned
// it into a number.
// ════════════════════════════════════════════════════════════════════════════

interface StoredItem {
  itemId: string;
  externalId: string;
  section: string;
  sport: string | null;
  title: string;
  url: string;
  author: string;
  createdAtSourceMs: number | null;
  postsOnSite: number | null;
  views: number | null;
  postsHeld: number;
  pageCount: number;
  firstPostAtMs: number | null;
  lastPostAtMs: number | null;
  entities: CoversEntities;
  fixtureKey: string | null;
  lastHarvestedAtMs: number | null;
}

interface StoredPost {
  postId: string;
  number: number | null;
  page: number | null;
  author: string;
  authorId: string;
  createdAtMs: number | null;
  body: string;
  chars: number;
  entities: CoversEntities;
}

interface TriageRow {
  analysisId: string;
  postId: string;
  itemId: string;
  section: string;
  outcome: TriageOutcome;
  screenReasons: ScreenReason[];
  jurisdiction: { blocked: boolean; matched: string[] };
  intent: {
    intent: PostIntent;
    problem: string;
    concepts: string[];
    asksSomething: boolean;
    confidence: number;
  } | null;
  retrieval: {
    matched: { assetId: string; title: string; score: number; why: { triggers: string[]; problems: string[] } }[];
    vetoed: { assetId: string; title: string; exclusion: string }[];
    topScore: number;
  } | null;
  variants: { brandMentioned: boolean; brandInformed: boolean; communityOnly: boolean };
  eligibilityReasons: Record<string, string>;
  score: number;
}

interface Gap {
  concept: string;
  posts: number;
  threads: number;
  examples: string[];
  sections: string[];
  domain: {
    verdict: DomainVerdict;
    evidence: DomainEvidence;
    matched: string[];
    reason: string;
    topic: OffDomainTopic | null;
  };
  seenWith: string[];
}

interface GapBoard {
  gaps: Gap[];
  unclassified: Gap[];
  offDomain: Gap[];
  counts: { inDomain: number; unclassified: number; offDomain: number };
}

interface GenerateResult {
  runId: string;
  opportunities: number;
  written: number;
  calls: { generate: number; score: number; critic: number };
  skipped: number;
  /** Keyed by variant kind, plus NONE. NONE is an outcome, counted like the
   *  others — see selectVariant.ts. */
  selected: Record<string, number>;
}

interface TriageResult {
  runId: string;
  section: string;
  posts: number;
  counts: Record<TriageOutcome, number>;
  intentCalls: number;
  budgetSkipped: number;
  board: GapBoard;
  written: number;
}

interface HarvestResult {
  summary: {
    section: string;
    listed: number;
    read: number;
    skipped: number;
    posts: number;
    fixtures: number;
    errors: string[];
  };
  saved: { itemsCreated: number; itemsUpdated: number; postsCreated: number; postsAlreadyHeld: number };
  requests: number;
}

/**
 * Tab labels, as a lookup.
 *
 * ⚠️ THIS WAS A NESTED TERNARY AND IT SHIPPED THREE TABS ALL CALLED "Sections".
 * The final `: 'Sections'` was the fallback, so every tab the chain did not name
 * explicitly silently took that label rather than failing. A Record keyed by the
 * tab union cannot do that — a new tab is a type error until it has a name.
 */
const TAB_LABEL: Record<'harvest' | 'knowledge' | 'queue' | 'sections' | 'policy', string> = {
  harvest: 'Harvest',
  knowledge: 'Knowledge',
  queue: 'Opportunities',
  sections: 'Sections',
  policy: 'Policy',
};

export default function CoversPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = use(params);

  const [config, setConfig] = useState<CoversModuleConfig | null>(null);
  const [catalogue, setCatalogue] = useState<CoversSection[]>([]);
  const [items, setItems] = useState<StoredItem[]>([]);
  const [posts, setPosts] = useState<Record<string, StoredPost[]>>({});
  const [open, setOpen] = useState<string | null>(null);

  const [section, setSection] = useState('');
  const [pages, setPages] = useState(1);
  const [maxThreads, setMaxThreads] = useState(10);

  const [tab, setTab] = useState<'harvest' | 'knowledge' | 'queue' | 'sections' | 'policy'>('harvest');
  /** Set from the policy view, so the harvest tab can warn before a run is
   *  spent producing community-only replies and nothing else. */
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [triage, setTriage] = useState<TriageRow[]>([]);
  const [triageResult, setTriageResult] = useState<TriageResult | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<HarvestResult | null>(null);
  // Bumped whenever settings arrive from the server. It is the SectionsTab's
  // key, so a saved config remounts that tab with the values the server kept —
  // rather than an effect syncing a prop into state on every render.
  const [configVersion, setConfigVersion] = useState(0);

  const load = useCallback(async () => {
    try {
      const [settings, harvested, policy] = await Promise.all([
        apiGet<{ config: CoversModuleConfig; catalogue: CoversSection[] }>(`/api/projects/${projectId}/covers`),
        apiGet<{ items: StoredItem[] }>(`/api/projects/${projectId}/covers/items`),
        // Read on every load so the warning cannot be missed by never opening
        // the Policy tab — which is exactly how the old Firestore-only setup
        // went unnoticed.
        apiGet<{ policy: { complianceConfirmed: boolean } }>(`/api/projects/${projectId}/covers/policy`),
      ]);
      setUnconfirmed(!policy.policy.complianceConfirmed);
      setConfig(settings.config);
      setConfigVersion((v) => v + 1);
      setCatalogue(settings.catalogue);
      setItems(harvested.items);
      setSection((s) => s || settings.config.sections[0]?.slug || '');
      setMaxThreads(settings.config.maxThreadsPerScan);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the Covers module.');
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const harvest = async () => {
    setBusy('harvest');
    setError(null);
    setResult(null);
    try {
      const res = await apiPost<HarvestResult>(`/api/projects/${projectId}/covers/harvest`, {
        section,
        pages,
        maxThreads,
      });
      setResult(res);
      const harvested = await apiGet<{ items: StoredItem[] }>(`/api/projects/${projectId}/covers/items`);
      setItems(harvested.items);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The harvest failed.');
    } finally {
      setBusy(null);
    }
  };

  const loadTriage = useCallback(
    async (all: boolean) => {
      try {
        const res = await apiGet<{ triage: TriageRow[] }>(
          `/api/projects/${projectId}/covers/triage?section=${encodeURIComponent(section)}${all ? '&all=1' : ''}`,
        );
        setTriage(res.triage);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'The queue could not be read.');
      }
    },
    [projectId, section],
  );

  const [generateResult, setGenerateResult] = useState<GenerateResult | null>(null);
  const [draftsKey, setDraftsKey] = useState(0);

  /**
   * Write the variants for the qualified opportunities of the last triage run.
   *
   * A THIRD BUTTON AND A THIRD BILL. Harvest spends somebody else's server,
   * triage spends one model call per surviving post, and this spends between two
   * and four per opportunity. Folding it into the triage button would hide the
   * most expensive step of the three behind the cheapest.
   */
  const runGeneration = async () => {
    setBusy('generate');
    setError(null);
    setGenerateResult(null);
    try {
      const res = await apiPost<GenerateResult>(`/api/projects/${projectId}/covers/drafts`, {
        section,
        runId: triageResult?.runId,
      });
      setGenerateResult(res);
      setDraftsKey((k) => k + 1);
      setTab('queue');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Generation failed.');
    } finally {
      setBusy(null);
    }
  };

  const runTriage = async () => {
    setBusy('triage');
    setError(null);
    setTriageResult(null);
    try {
      const res = await apiPost<TriageResult>(`/api/projects/${projectId}/covers/triage`, { section });
      setTriageResult(res);
      setTab('queue');
      await loadTriage(showAll);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Triage failed.');
    } finally {
      setBusy(null);
    }
  };

  const toggle = async (itemId: string) => {
    if (open === itemId) {
      setOpen(null);
      return;
    }
    setOpen(itemId);
    if (posts[itemId]) return;
    try {
      const res = await apiGet<{ posts: StoredPost[] }>(
        `/api/projects/${projectId}/covers/items?itemId=${encodeURIComponent(itemId)}`,
      );
      setPosts((p) => ({ ...p, [itemId]: res.posts }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Those posts could not be read back.');
    }
  };

  const saveSections = async (sections: CoversSection[]) => {
    if (!config) return;
    setBusy('sections');
    setError(null);
    try {
      const res = await apiFetch<{ config: CoversModuleConfig }>(`/api/projects/${projectId}/covers`, {
        method: 'PUT',
        body: JSON.stringify({ config: { ...config, sections } }),
      });
      setConfig(res.config);
      setConfigVersion((v) => v + 1);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Those settings were not saved.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <PageHeader
        title="Covers"
        description="Read the forum and keep what it said. Nothing here is scored, drafted or posted."
        crumbs={[
          { label: 'Projects', href: '/projects' },
          { label: 'Project', href: `/projects/${projectId}` },
          { label: 'Covers' },
        ]}
      />

      {error && (
        <div className="alert alert-error">
          <AlertTriangle size={15} aria-hidden /> {error}
        </div>
      )}

      <div className="tabs">
        {(['harvest', 'knowledge', 'queue', 'sections', 'policy'] as const).map((t) => (
          <button
            key={t}
            className={`tab ${tab === t ? 'active' : ''}`}
            onClick={() => {
              setTab(t);
              if (t === 'queue') void loadTriage(showAll);
            }}
            style={{ background: 'none', border: 'none', cursor: 'pointer' }}
          >
            {TAB_LABEL[t]}{t === 'policy' && unconfirmed ? ' ⚠️' : ''}
          </button>
        ))}
      </div>

      {tab === 'knowledge' && <CoversKnowledgeTab projectId={projectId} />}

      {tab === 'policy' && (
        <CoversPolicyTab projectId={projectId} onSaved={() => setUnconfirmed(false)} />
      )}

      {tab === 'harvest' && (
        <div className="sections">
          <section className="card">
            <div className="card-head">
              <h3>Read a section</h3>
            </div>

            <div className="grid-form">
              <div className="field">
                <label className="label">Section</label>
                <select value={section} onChange={(e) => setSection(e.target.value)}>
                  {(config?.sections ?? []).map((s) => (
                    <option key={s.slug} value={s.slug}>
                      {s.name} — {s.roles.map((r) => SECTION_ROLE_LABEL[r]).join(', ')}
                    </option>
                  ))}
                </select>
              </div>

              <div className="field">
                <label className="label">Listing pages</label>
                <input
                  type="number"
                  min={1}
                  max={config?.pagesPerSection ?? 1}
                  value={pages}
                  onChange={(e) => setPages(Number(e.target.value))}
                />
              </div>

              <div className="field">
                <label className="label">Threads to open</label>
                <input
                  type="number"
                  min={0}
                  max={config?.maxThreadsPerScan ?? 10}
                  value={maxThreads}
                  onChange={(e) => setMaxThreads(Number(e.target.value))}
                />
              </div>
            </div>

            <p className="text-dim small">
              One request for the listing and one for each thread opened, paced 1.2 seconds apart.
              The ceilings come from this project&apos;s settings — a bigger number here cannot raise them.
            </p>

            {/* Said BEFORE the money is spent. A run against an unconfirmed
                policy is not wasted — the community reply is a complete answer
                — but nobody should discover afterwards that two of the three
                variants were never written. */}
            {unconfirmed && (
              <div className="alert alert-warn" style={{ marginBottom: '0.75rem' }}>
                <strong>This client&apos;s compliance decisions are not confirmed.</strong> Only the
                community-only reply will be written — the variants that draw on the client are withheld
                until the prohibited jurisdictions and disclosure wording have been answered.{' '}
                <button className="btn btn-ghost btn-sm" onClick={() => setTab('policy')}>
                  Open Policy
                </button>
              </div>
            )}

            <div className="row">
              <button className="btn btn-primary btn-sm" onClick={harvest} disabled={!!busy || !section}>
                <Download size={14} /> {busy === 'harvest' ? 'Reading…' : 'Harvest'}
              </button>
              {/* Separate button and separate permission: harvesting spends
                  somebody else's server, triage spends model credit. */}
              <button className="btn btn-secondary btn-sm" onClick={runTriage} disabled={!!busy || !section}>
                <Filter size={14} /> {busy === 'triage' ? 'Triaging…' : 'Triage what we hold'}
              </button>
              {/* The third bill. Two to four model calls per opportunity, and
                  it writes nothing that could not have been posted — the
                  eligibility mask ran for free in triage. */}
              <button className="btn btn-secondary btn-sm" onClick={runGeneration} disabled={!!busy || !section}>
                <PenLine size={14} /> {busy === 'generate' ? 'Writing…' : 'Write drafts'}
              </button>
            </div>

            {generateResult && (
              <div className="alert alert-info" style={{ marginTop: '0.75rem' }}>
                <div>
                  {generateResult.opportunities} qualified opportunit
                  {generateResult.opportunities === 1 ? 'y' : 'ies'} · wrote {generateResult.written} draft
                  {generateResult.written === 1 ? '' : 's'} ·{' '}
                  {generateResult.calls.generate + generateResult.calls.score + generateResult.calls.critic} model
                  calls ({generateResult.calls.generate} write, {generateResult.calls.score} score,{' '}
                  {generateResult.calls.critic} critic)
                </div>
                <div className="small text-dim">
                  {Object.entries(generateResult.selected)
                    .map(([k, n]) => `${n} ${k}`)
                    .join(' · ') || 'nothing selected'}
                  {generateResult.skipped > 0 && ` · ${generateResult.skipped} not reached (cap)`}
                </div>
              </div>
            )}

            {result && (
              <div className="alert alert-info" style={{ marginTop: '0.75rem' }}>
                <div>
                  <strong>{result.summary.section}</strong> — listed {result.summary.listed} threads, read{' '}
                  {result.summary.read} of them in {result.requests} requests
                  {result.summary.skipped > 0 &&
                    `, skipped ${result.summary.skipped} already held and unchanged`}
                  .{' '}
                  {result.saved.itemsCreated} new, {result.saved.itemsUpdated} already held.{' '}
                  {result.saved.postsCreated} new posts ({result.saved.postsAlreadyHeld} seen before).
                  {result.summary.fixtures > 0 && ` ${result.summary.fixtures} fixtures identified.`}
                  {result.summary.errors.length > 0 && (
                    <ul className="small" style={{ marginTop: '0.4rem' }}>
                      {result.summary.errors.map((e, i) => (
                        <li key={i}>{e}</li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            )}
          </section>

          <section className="card">
            <div className="card-head">
              <h3>Harvested threads</h3>
              <span className="badge">{items.length}</span>
            </div>

            {items.length === 0 ? (
              <div className="empty">
                <p>Nothing harvested yet. Read a section above.</p>
              </div>
            ) : (
              <ul className="list">
                {items.map((item) => (
                  <li key={item.itemId} className="list-row" style={{ display: 'block' }}>
                    <div className="row" style={{ justifyContent: 'space-between', width: '100%' }}>
                      <button
                        onClick={() => void toggle(item.itemId)}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', padding: 0 }}
                      >
                        <div className="row">
                          {open === item.itemId ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                          <div>
                            <strong>{item.title || 'Untitled thread'}</strong>
                            <div className="text-dim small">
                              {item.section}
                              {item.author && ` · by ${item.author}`}
                              {` · ${item.postsHeld} posts held`}
                              {item.pageCount > 1 && ` of ${item.pageCount} pages`}
                            </div>
                          </div>
                        </div>
                      </button>

                      <a href={item.url} target="_blank" rel="noreferrer" className="btn btn-secondary btn-sm">
                        Open <ExternalLink size={13} />
                      </a>
                    </div>

                    <div className="row small text-dim" style={{ flexWrap: 'wrap', gap: '0.75rem', marginTop: '0.35rem' }}>
                      <span>
                        <Clock size={12} aria-hidden /> {age(item.lastPostAtMs)}
                      </span>
                      {/* NOT MEASURED is a different statement from zero, and the
                          screen makes it in words rather than showing a 0. */}
                      <span>
                        <MessagesSquare size={12} aria-hidden />{' '}
                        {item.postsOnSite === null
                          ? 'thread length not measured'
                          : `${item.postsOnSite} posts on site`}
                      </span>
                      <span>
                        <Eye size={12} aria-hidden />{' '}
                        {item.views === null ? 'views not measured' : `${item.views} views`}
                      </span>
                      <Entities entities={item.entities} fixtureKey={item.fixtureKey} />
                    </div>

                    {open === item.itemId && (
                      <div style={{ marginTop: '0.6rem', paddingLeft: '1.4rem' }}>
                        {!posts[item.itemId] ? (
                          <p className="text-dim small">Reading the posts back…</p>
                        ) : (
                          <ul className="list">
                            {posts[item.itemId].map((p) => (
                              <li key={p.postId} className="list-row" style={{ display: 'block' }}>
                                <div className="text-dim small">
                                  {p.number !== null && `#${p.number} · `}
                                  {p.author || 'unknown author'}
                                  {p.createdAtMs !== null && ` · ${utc(p.createdAtMs)}`}
                                  {p.page !== null && ` · page ${p.page}`}
                                </div>
                                <div className="small" style={{ whiteSpace: 'pre-wrap', marginTop: '0.25rem' }}>
                                  {p.body || <em className="text-dim">empty post</em>}
                                </div>
                                <div style={{ marginTop: '0.3rem' }}>
                                  <Entities entities={p.entities} fixtureKey={p.entities.fixture?.key ?? null} />
                                </div>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}

      {tab === 'queue' && (
        <div className="sections">
          {triageResult && (
            <section className="card">
              <div className="card-head">
                <h3>Last run — {triageResult.section}</h3>
                <span className="badge">{triageResult.intentCalls} model calls</span>
              </div>

              <p className="text-dim small">
                {triageResult.posts} posts examined for nothing, {triageResult.intentCalls} classified.
                {triageResult.budgetSkipped > 0 && (
                  <>
                    {' '}
                    <strong>{triageResult.budgetSkipped} were never reached — the run hit its budget.</strong>{' '}
                    Those are not findings; run it again to cover them.
                  </>
                )}
              </p>

              <div className="row" style={{ flexWrap: 'wrap', gap: '0.4rem' }}>
                {(Object.keys(triageResult.counts) as TriageOutcome[])
                  .filter((k) => triageResult.counts[k] > 0)
                  .map((k) => (
                    <span key={k} className={`badge ${k === 'opportunity' ? 'badge-success' : ''}`}>
                      {triageResult.counts[k]} {OUTCOME_LABEL[k].toLowerCase()}
                    </span>
                  ))}
              </div>
            </section>
          )}

          {/* ── The gap board, in three trays ───────────────────────────── */}
          {triageResult && (
            <GapTray
              title="What people ask that we cannot answer"
              blurb="Demand with nothing in the library behind it, on a subject this client could speak to. A finding, not a failure — and counted by THREAD as well as by post, because twenty replies inside one argument is one conversation."
              rows={triageResult.board.gaps}
              tone="primary"
            />
          )}

          {triageResult && (
            <GapTray
              title="Asked, and nothing recognised it"
              blurb="Neither the client's library, the betting vocabulary nor this section's teams knew these words. That is what an unmet need looks like from the outside, so nothing here is thrown away — read the ones seen alongside in-domain concepts first."
              rows={triageResult.board.unclassified}
              tone="muted"
              collapsedByDefault
            />
          )}

          {triageResult && (
            <GapTray
              title="Filtered out as off-domain"
              blurb="Rejected, with the term that rejected it. Shown rather than dropped: this filter will be wrong sometimes, and a mistake nobody can see is a mistake nobody can fix."
              rows={triageResult.board.offDomain}
              tone="muted"
              collapsedByDefault
            />
          )}

          {/* ── The drafts ───────────────────────────────────────────────── */}
          <CoversDraftReview projectId={projectId} section={section} refreshKey={draftsKey} />

          {/* ── The ranked queue ─────────────────────────────────────────── */}
          <section className="card">
            <div className="card-head">
              <h3>
                <Target size={16} aria-hidden /> Opportunities
              </h3>
              <label className="row small" style={{ gap: '0.35rem' }}>
                <input
                  type="checkbox"
                  checked={showAll}
                  onChange={(e) => {
                    setShowAll(e.target.checked);
                    void loadTriage(e.target.checked);
                  }}
                />
                Show everything that was rejected too
              </label>
            </div>

            <p className="text-dim small">
              Ranked, best first. <strong>The score orders this list and measures nothing</strong> — it is
              uncalibrated until real decisions have been compared against it. Nothing here is a draft:
              writing replies is the next phase.
            </p>

            {triage.length === 0 ? (
              <div className="empty">
                <p>Nothing yet. Harvest a section, then triage what it read.</p>
              </div>
            ) : (
              <ul className="list">
                {triage.map((row) => (
                  <li key={row.analysisId} className="list-row" style={{ display: 'block' }}>
                    <div className="row" style={{ justifyContent: 'space-between', gap: '1rem' }}>
                      <div>
                        <strong>{row.intent?.problem || OUTCOME_LABEL[row.outcome]}</strong>
                        <div className="text-dim small">
                          {row.intent && `${INTENT_LABEL[row.intent.intent]} · `}
                          {row.section} · post {row.postId}
                        </div>
                      </div>
                      <div className="row">
                        {row.outcome === 'opportunity' ? (
                          <span className="badge badge-success">{row.score}</span>
                        ) : (
                          <span className="badge">{OUTCOME_LABEL[row.outcome]}</span>
                        )}
                      </div>
                    </div>

                    {/* Why it stopped, when it did. Every reason, not the first. */}
                    {row.screenReasons.length > 0 && (
                      <div className="row small text-dim" style={{ flexWrap: 'wrap', gap: '0.4rem', marginTop: '0.3rem' }}>
                        {row.screenReasons.map((r) => (
                          <span key={r} className="chip">
                            {SCREEN_REASON_LABEL[r] ?? r}
                          </span>
                        ))}
                      </div>
                    )}

                    {row.jurisdiction.blocked && (
                      <div className="alert alert-error small" style={{ marginTop: '0.3rem' }}>
                        Names {row.jurisdiction.matched.join(', ')} — the client cannot serve there.
                      </div>
                    )}

                    <div className="row small text-dim" style={{ flexWrap: 'wrap', gap: '0.5rem', marginTop: '0.35rem' }}>
                      {row.intent?.concepts.map((c) => (
                        <span key={c} className="chip">
                          {c}
                        </span>
                      ))}
                      {/* The phrase that fired, not just a count: a reviewer who
                          can see WHY a match happened can fix the library. */}
                      {row.retrieval?.matched.slice(0, 2).map((m) => (
                        <span
                          key={m.assetId}
                          className="chip text-success"
                          title={`matched: ${[...m.why.triggers, ...m.why.problems].join(', ')}`}
                        >
                          {m.title} ({m.score})
                        </span>
                      ))}
                      {/* "Found and rejected" is not "found nothing", and only
                          one of them means the library has a gap. */}
                      {row.retrieval?.vetoed.map((v) => (
                        <span key={v.assetId} className="chip text-warning" title={v.title}>
                          vetoed: {v.exclusion}
                        </span>
                      ))}
                    </div>

                    <div className="row small" style={{ flexWrap: 'wrap', gap: '0.5rem', marginTop: '0.3rem' }}>
                      {(
                        [
                          ['brandMentioned', 'Names the client'],
                          ['brandInformed', 'Informed by the library'],
                          ['communityOnly', 'Community reply'],
                        ] as const
                      ).map(([key, label]) => (
                        <span
                          key={key}
                          className={`chip ${row.variants[key] ? 'text-success' : 'text-dim'}`}
                          title={row.variants[key] ? 'Eligible' : row.eligibilityReasons[key] ?? 'Not eligible'}
                        >
                          {row.variants[key] ? '✓' : '✕'} {label}
                        </span>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}

      {tab === 'sections' && config && (
        <SectionsTab
          key={configVersion}
          config={config}
          catalogue={catalogue}
          busy={busy === 'sections'}
          onSave={saveSections}
        />
      )}
    </>
  );
}

/** Teams, fixture and quoted lines, as chips. Silence about a league we have no
 *  lexicon for is stated, not implied by an empty row. */
function Entities({ entities, fixtureKey }: { entities: CoversEntities; fixtureKey: string | null }) {
  if (!entities) return null;

  if (entities.sport && !entities.lexicon) {
    return <span className="chip text-dim">no team list for {entities.sport}</span>;
  }

  return (
    <>
      {fixtureKey && entities.fixture && (
        <span className="chip">
          <Layers size={12} aria-hidden />{' '}
          {entities.fixture.away && entities.fixture.home
            ? `${teamLabel(entities.fixture.away)} at ${teamLabel(entities.fixture.home)}`
            : entities.fixture.teams.map(teamLabel).join(' v ')}
        </span>
      )}
      {!fixtureKey &&
        entities.teams.slice(0, 4).map((t) => (
          <span key={t} className="chip">
            {teamLabel(t)}
          </span>
        ))}
      {entities.lines.slice(0, 4).map((l, i) => (
        <span key={i} className="chip text-mono" title={`${l.kind}${l.teamKey ? ` · ${teamLabel(l.teamKey)}` : ''}`}>
          {l.raw}
        </span>
      ))}
    </>
  );
}

function SectionsTab({
  config,
  catalogue,
  busy,
  onSave,
}: {
  config: CoversModuleConfig;
  catalogue: CoversSection[];
  busy: boolean;
  onSave: (sections: CoversSection[]) => void;
}) {
  // Seeded once per mount; the parent remounts this with a new key whenever the
  // server hands back a config, so there is no prop-into-state effect to go
  // stale or to fire a second render.
  const [draft, setDraft] = useState<CoversSection[]>(config.sections);

  const setRole = (slug: string, role: SectionRole, on: boolean) => {
    setDraft((d) =>
      d.map((s) =>
        s.slug === slug
          ? { ...s, roles: on ? [...new Set([...s.roles, role])] : s.roles.filter((r) => r !== role) }
          : s,
      ),
    );
  };

  const missing = catalogue.filter((c) => !draft.some((d) => d.slug === c.slug));

  return (
    <div className="sections">
      <section className="card">
        <div className="card-head">
          <h3>Sections and what each is for</h3>
          <button className="btn btn-primary btn-sm" onClick={() => onSave(draft)} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>

        <p className="text-dim small">
          These are Covers&apos; own rules written down. Commercial posts belong in Website Promotions and are
          bannable elsewhere, so the role decides which reply variants are eligible before anything is
          generated. A section with no role is dropped rather than defaulted.
        </p>

        <ul className="list">
          {draft.map((s) => (
            <li key={s.slug} className="list-row" style={{ display: 'block' }}>
              <div>
                <strong>{s.name}</strong>
                <span className="text-dim small"> {s.slug}</span>
                {s.sport && <span className="badge">{s.sport}</span>}
              </div>
              <div className="row" style={{ gap: '0.9rem', marginTop: '0.35rem', flexWrap: 'wrap' }}>
                {(Object.keys(SECTION_ROLE_LABEL) as SectionRole[]).map((role) => (
                  <label key={role} className="row small" style={{ gap: '0.3rem' }}>
                    <input
                      type="checkbox"
                      checked={s.roles.includes(role)}
                      onChange={(e) => setRole(s.slug, role, e.target.checked)}
                    />
                    {SECTION_ROLE_LABEL[role]}
                  </label>
                ))}
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => setDraft((d) => d.filter((x) => x.slug !== s.slug))}
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      </section>

      {missing.length > 0 && (
        <section className="card">
          <div className="card-head">
            <h3>Sections seen on Covers, not yet added</h3>
          </div>
          <ul className="list">
            {missing.map((s) => (
              <li key={s.slug} className="list-row">
                <div>
                  <strong>{s.name}</strong>
                  <div className="text-dim small">
                    {s.slug} · default role {s.roles.map((r) => SECTION_ROLE_LABEL[r]).join(', ')}
                  </div>
                </div>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => setDraft((d) => [...d, { ...s, roles: [...s.roles] }])}
                >
                  Add
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/** Post times are stored as UTC and shown as UTC, labelled. The page displays ET
 *  and the attribute is UTC; showing an unlabelled local time is how a four-hour
 *  error hides in plain sight. */
function utc(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function age(ms: number | null): string {
  if (ms === null) return 'age unknown';
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 60) return `${mins}m old`;
  if (mins < 60 * 48) return `${Math.round(mins / 60)}h old`;
  return `${Math.round(mins / 1440)}d old`;
}

/**
 * One tray of the gap board.
 *
 * ⚠️ THE OFF-DOMAIN TRAY IS RENDERED, NOT SUPPRESSED. It is the only place a
 * wrong filtering decision can be seen, and every row carries the term that
 * rejected it and the topic it was rejected under, so correcting the list is a
 * matter of reading the screen rather than reading the code.
 *
 * An empty tray still renders its heading and says it is empty. A tray that
 * vanishes when it has nothing in it reads as a feature that did not run.
 */
function GapTray({
  title,
  blurb,
  rows,
  tone,
  collapsedByDefault = false,
}: {
  title: string;
  blurb: string;
  rows: Gap[];
  tone: 'primary' | 'muted';
  collapsedByDefault?: boolean;
}) {
  const [open, setOpen] = useState(!collapsedByDefault);

  return (
    <section className="card">
      <div className="card-head">
        <h3>
          <HelpCircle size={16} aria-hidden /> {title}
          <span className="badge" style={{ marginLeft: '0.5rem' }}>
            {rows.length}
          </span>
        </h3>
        <button className="btn btn-ghost btn-sm" onClick={() => setOpen((o) => !o)}>
          {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
          {open ? 'Hide' : 'Show'}
        </button>
      </div>

      {open && (
        <>
          <p className="text-dim small">{blurb}</p>
          {rows.length === 0 ? (
            <p className="text-dim small">Nothing on this tray from the last run.</p>
          ) : (
            <ul className="list">
              {rows.map((g) => (
                <li key={g.concept} className="list-row" style={{ display: 'block' }}>
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <strong style={{ opacity: tone === 'muted' ? 0.85 : 1 }}>{g.concept}</strong>
                    <span className="badge">
                      {g.threads} thread{g.threads === 1 ? '' : 's'} · {g.posts} post
                      {g.posts === 1 ? '' : 's'}
                    </span>
                  </div>

                  {/* Why it is on this tray — the whole reason the filter is
                      auditable rather than merely opinionated. */}
                  <div className="small text-dim" style={{ marginTop: '0.25rem' }}>
                    {g.domain.topic && (
                      <span className="badge" style={{ marginRight: '0.4rem' }}>
                        {OFF_DOMAIN_TOPIC_LABEL[g.domain.topic]}
                      </span>
                    )}
                    {g.domain.reason}
                  </div>

                  {g.seenWith.length > 0 && (
                    <div className="small text-dim" style={{ marginTop: '0.2rem' }}>
                      seen alongside: {g.seenWith.join(', ')}
                    </div>
                  )}

                  <ul className="small text-dim" style={{ marginTop: '0.3rem' }}>
                    {g.examples.map((e, i) => (
                      <li key={i}>{e}</li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
