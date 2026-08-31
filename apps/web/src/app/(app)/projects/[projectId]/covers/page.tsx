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
} from 'lucide-react';
import PageHeader from '@/components/PageHeader';
import { apiGet, apiPost, apiFetch, ApiError } from '@/lib/api';
import { SECTION_ROLE_LABEL, type CoversSection, type SectionRole } from '@/modules/covers/sections';
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

  const [tab, setTab] = useState<'harvest' | 'sections'>('harvest');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<HarvestResult | null>(null);
  // Bumped whenever settings arrive from the server. It is the SectionsTab's
  // key, so a saved config remounts that tab with the values the server kept —
  // rather than an effect syncing a prop into state on every render.
  const [configVersion, setConfigVersion] = useState(0);

  const load = useCallback(async () => {
    try {
      const [settings, harvested] = await Promise.all([
        apiGet<{ config: CoversModuleConfig; catalogue: CoversSection[] }>(`/api/projects/${projectId}/covers`),
        apiGet<{ items: StoredItem[] }>(`/api/projects/${projectId}/covers/items`),
      ]);
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
        {(['harvest', 'sections'] as const).map((t) => (
          <button
            key={t}
            className={`tab ${tab === t ? 'active' : ''}`}
            onClick={() => setTab(t)}
            style={{ background: 'none', border: 'none', cursor: 'pointer' }}
          >
            {t === 'harvest' ? 'Harvest' : 'Sections'}
          </button>
        ))}
      </div>

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

            <div className="row">
              <button className="btn btn-primary btn-sm" onClick={harvest} disabled={!!busy || !section}>
                <Download size={14} /> {busy === 'harvest' ? 'Reading…' : 'Harvest'}
              </button>
            </div>

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
