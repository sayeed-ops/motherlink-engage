'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { collection, limit, orderBy, query } from 'firebase/firestore';
import { Check, ListChecks, Search, SlidersHorizontal, TrendingUp } from 'lucide-react';
import { db } from '@/lib/firebase/config';
import { subscribe } from '@/lib/data';
import { apiFetch, ApiError } from '@/lib/api';
import {
  draftFreshness,
  normalizeDraft,
  type CommentDraftRecord,
} from '@/modules/forum/reply/drafts';
import { fitKnobs, summarise, toSamples } from '@/modules/forum/reply/learn';
import CommentScanCard from '@/components/CommentScanCard';
import { GAP_STATE_SHORT } from '@/modules/forum/reply/explain';
import type { CommentJobView } from '@/server/commentKarmaJobs';
import { LISTING_FEEDS } from '@/modules/forum/reader/discovery';
import {
  anyRelaxed,
  accountCommentSettings,
  scanReadiness,
  type CommentKarmaSettings,
  type CommunityKeywords,
} from '@/modules/forum/reply/settings';

// The Comment karma tab.
//
// Two things it must be honest about, because both are easy to imply and wrong:
//
//   1. APPROVING QUEUES IT, AND THE ACCOUNT WILL POST IT. This is now the
//      irreversible click, and the panel says so before the button rather than
//      after. It also reports what happened next, because approval and enqueue
//      are two different outcomes: a comment can be approved and still refused
//      by the rails (stale thread, daily cap, already commented in that
//      community today, another job in flight), and an operator who is not told
//      that assumes a comment is coming when it is not.
//
//   2. A SKIP IS NOT A FAILURE. Most scans produce no comment on purpose, so
//      the list is mostly skips — and if they were hidden, twenty scans with no
//      comment would look like a broken feature instead of a working one. They
//      are rendered compactly, with the stage they stopped at.

// Two different windows over one subscription. The FIGURES need depth — most
// scans are skips, so 40 records might hold only a handful of posted comments,
// which is not enough to learn anything from — while the LIST only needs to be
// recent enough to review. Same number the server reads when it fits the scan's
// knobs, so the panel and the scan can never disagree about what the data says.
const MAX_ROWS = 200;
const LIST_ROWS = 40;

interface Props {
  accountId: string;
  saved: unknown;
  /** Where a scan may look and what it may search for — built by commentPairs()
   *  on the page, from the same helper the server scans with. */
  pairs: CommunityKeywords[];
  /** Communities tagged Comment that were left out because the account has not
   *  joined them. Only used to explain an empty `pairs`. */
  notJoined?: number;
  canManage: boolean;
}

function words(list: string[]): string {
  return list.join(', ');
}

/** "0,55" is 0.55.
 *
 *  A browser in a comma-decimal locale renders 0.75 as `0,75` and hands the
 *  value back the same way, and Number() makes NaN of it — which the server
 *  then ignores, keeping the old value while the field shows the new one.
 *  Silent, and the worst kind: the setting looks applied and isn't. The server
 *  now defends against this too; this stops it ever leaving the browser. */
function decimal(value: string): number {
  return Number(value.replace(',', '.'));
}

function parseList(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export default function CommentKarmaPanel({ accountId, saved, pairs, notJoined = 0, canManage }: Props) {
  const [settings, setSettings] = useState<CommentKarmaSettings>(() => accountCommentSettings(saved));
  const [rows, setRows] = useState<CommentDraftRecord[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // The job behind each queued comment — its posting route. Keyed by draft id.
  const [jobs, setJobs] = useState<Record<string, CommentJobView>>({});
  const [note, setNote] = useState<Record<string, string>>({});
  const [view, setView] = useState<View>('scans');
  const [filter, setFilter] = useState<Filter>('review');
  // Read once into state rather than during render: a clock read in a render
  // body is impure, and staleness would then change under any re-render.
  const [nowMs] = useState(() => Date.now());
  const [sweeping, setSweeping] = useState(false);

  useEffect(() => {
    const q = query(
      collection(db, 'accounts', accountId, 'commentDrafts'),
      orderBy('createdAtMs', 'desc'),
      limit(MAX_ROWS),
    );
    return subscribe<Record<string, unknown> & { id: string }>(
      q,
      (docs) => {
        setRows(docs.map((d) => normalizeDraft(d.id, d)).filter((d): d is CommentDraftRecord => !!d));
        setLoaded(true);
      },
      (err) => {
        setError(err.message);
        setLoaded(true);
      },
    );
  }, [accountId]);

  // Fetched again whenever a comment is queued or posted, so the Approach tab
  // shows the plan as soon as there is one and the route once it has run.
  const jobKey = rows
    .filter((r) => r.status === 'queued' || r.status === 'posted')
    .map((r) => `${r.draftId}:${r.status}`)
    .join(',');
  useEffect(() => {
    if (!jobKey) return;
    let live = true;
    apiFetch<{ jobs: Record<string, CommentJobView> }>(`/api/accounts/${accountId}/comment-karma/jobs`)
      .then((res) => {
        if (live) setJobs(res.jobs);
      })
      .catch(() => {
        // The routes are a view onto the jobs, not part of reviewing a comment;
        // the card says when there is none.
      });
    return () => {
      live = false;
    };
  }, [accountId, jobKey]);

  const readiness = useMemo(() => scanReadiness(settings, pairs, notJoined), [settings, pairs, notJoined]);
  const relaxed = anyRelaxed(settings.relax);

  // What the outcomes say — computed HERE, from the rows already subscribed to,
  // with the same pure functions the server uses to fit the knobs. Not a second
  // implementation and not a second fetch: the panel and the scan must agree
  // about what the numbers say, and the cheapest way to guarantee that is one
  // implementation with two call sites. It also updates live as a sweep writes.
  const learning = useMemo(() => {
    const samples = toSamples(rows);
    return { samples, summary: summarise(samples), knobs: fitKnobs(samples) };
  }, [rows]);

  async function sweep() {
    setSweeping(true);
    setError(null);
    setNotice(null);
    try {
      const res = await apiFetch<{ sweep: { checked: number; removed: number; pending: number; calls: number; notes: string[] } }>(
        `/api/accounts/${accountId}/comment-karma/outcomes`,
        { method: 'POST' },
      );
      const s = res.sweep;
      setNotice(
        s.checked
          ? `Checked ${s.checked} comment(s)${s.removed ? `, ${s.removed} removed` : ''}. ${s.pending} not due yet.`
          : `Nothing due yet — ${s.pending} comment(s) waiting for their next check.`,
      );
      // No reload needed — the sweep writes to the records this panel is
      // subscribed to, so the numbers move on their own.
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The outcome sweep could not run.');
    } finally {
      setSweeping(false);
    }
  }

  async function save(patch: Partial<CommentKarmaSettings>) {
    const next = { ...settings, ...patch };
    setSettings(next);
    setError(null);
    setNotice(null);
    try {
      const res = await apiFetch<{ settings: CommentKarmaSettings }>(
        `/api/accounts/${accountId}/comment-karma/settings`,
        { method: 'PUT', body: JSON.stringify({ settings: next }) },
      );
      // Take the server's normalised copy back, so a clamped number shows the
      // value that was actually stored rather than the one that was typed.
      setSettings(res.settings);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save.');
      setSettings(accountCommentSettings(saved));
    }
  }

  async function scan() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await apiFetch<{
        outcome: { produced: boolean; skipReason: string };
        autoApproved: boolean;
        enqueue?: { queued: boolean; reason: string };
      }>(
        `/api/accounts/${accountId}/comment-karma/scan`,
        { method: 'POST' },
      );
      setNotice(
        res.outcome.produced
          ? res.autoApproved
            ? res.enqueue?.queued
              ? 'Wrote a comment, approved it automatically and queued it. The agent will browse to the thread and post it.'
              : `Wrote and approved a comment, but it was not queued — ${res.enqueue?.reason ?? 'no reason given'}`
            : 'Wrote a comment. It is waiting for you below.'
          : `No comment this time — ${res.outcome.skipReason}`,
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The scan could not run.');
    } finally {
      setBusy(false);
    }
  }

  async function review(draftId: string, action: 'approve' | 'reject' | 'queue') {
    setError(null);
    setNotice(null);
    try {
      const res = await apiFetch<{ enqueue?: { queued: boolean; reason: string } }>(
        `/api/accounts/${accountId}/comment-karma/drafts/${draftId}`,
        { method: 'PATCH', body: JSON.stringify({ action, note: note[draftId] ?? '' }) },
      );
      if (action === 'reject') {
        setNotice('Rejected. The note is kept as training data.');
      } else if (res.enqueue?.queued) {
        setNotice('Queued. The agent will browse to the thread and post it.');
      } else {
        // Approved but not queued is a rail working, not an error — and the
        // draft stays approved, so it can be queued again later.
        setNotice(`Approved, but NOT queued — ${res.enqueue?.reason ?? 'no reason given'}`);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not record that.');
    }
  }

  // Only what still needs a person, or is on its way: everything already decided
  // (posted, rejected, nothing found, failed) is in Account activity — the one
  // history view (operator, 2026-10-27).
  const IN_FLIGHT = ['approved', 'queued'];
  const counts = {
    review: rows.filter((r) => r.status === 'pending').length,
    inflight: rows.filter((r) => IN_FLIGHT.includes(r.status)).length,
  };
  const shown = rows
    .filter((r) => (filter === 'review' ? r.status === 'pending' : IN_FLIGHT.includes(r.status)))
    .slice(0, LIST_ROWS);

  const limitFields: [keyof CommentKarmaSettings['limits'], string, string][] = [
    ['minAgeMinutes', 'Youngest post', 'minutes · fewer readers than this is too early to judge'],
    ['maxAgeHours', 'Oldest post', 'hours · after this the top spots are taken'],
    ['maxComments', 'Most comments', 'more than this and a new comment is lost'],
    ['maxTopCommentScore', 'Top comment ceiling', 'points · above this it is out of reach'],
    ['visibleCommentScore', '“Visible” comment score', 'points · how many rivals readers actually see'],
    ['minUpvoteRatio', 'Lowest upvote ratio', '0–1 · below this the room is arguing'],
  ];
  const railFields: [keyof CommentKarmaSettings, string, string, number, number][] = [
    ['dailyCap', 'Comments per day', 'karma comments only', 1, 20],
    ['minIntervalMinutes', 'Minimum gap', 'minutes between two comments', 15, 1440],
    ['combinedDailyCap', 'Combined daily ceiling', 'replies and comments together', 1, 30],
    ['maxPerSubredditPerDay', 'Per community', 'per day', 1, 5],
    ['maxThreadsPerScan', 'Threads read per scan', 'each read is a billed call', 1, 8],
  ];
  const relaxFields: [keyof CommentKarmaSettings['relax'], string, string][] = [
    ['ignoreGap', 'Comment even with nothing to add', 'Writes something even when the thread already has the answer. Filler by definition.'],
    ['ignoreOpportunity', 'Enter unpromising threads', 'Crowded, out of reach, outside the age window, not rising, scores hidden.'],
    ['ignoreBotTell', 'Ignore the account’s rhythm', 'Comment timing, repeated openings, similar lengths.'],
    ['ignoreCritic', 'Post even if the reviewer picks none', 'Uses the first draft that passed the checks.'],
  ];

  return (
    <div className="ck">
      {/* ── Header: what this is, whether it is on, and the one action ── */}
      <section className="card ck-hero">
        <div className="ck-hero-main">
          <div className="ck-hero-title">
            <h3>Comment karma</h3>
            <span className={`badge ${settings.enabled ? 'badge-success' : ''}`}>{settings.enabled ? 'On' : 'Off'}</span>
            {settings.autoPost && settings.enabled && <span className="badge badge-info">Approves automatically</span>}
            {relaxed && <span className="badge badge-warning">Testing switches on</span>}
          </div>
          <p className="ck-lede">
            Ordinary comments in the communities tagged <strong>Comment</strong>, written only when a thread is
            missing something. Most scans find nothing — that is on purpose.
          </p>
          <details className="ck-more">
            <summary>How it works</summary>
            <p>
              Each scan picks a community, finds a thread still early enough to be seen, and reads what is already
              there. It writes only if the thread is missing something, copying the length and tone of the comments
              doing well. A system that always finds something to say posts filler, and filler is what gets an
              account noticed.
            </p>
            <p>
              <strong>Approving queues it.</strong> The agent opens this account&rsquo;s browser, browses to the
              thread the way a person would, and posts. It is checked again on the way out — a stale thread, the
              daily cap, or a comment already made in that community today holds it back, and the card says which.
            </p>
          </details>
        </div>
        <div className="ck-hero-side">
          <Switch
            label="Enabled"
            checked={settings.enabled}
            disabled={!canManage}
            onChange={(v) => void save({ enabled: v })}
          />
          <Switch
            label="Approve automatically"
            hint="Same checks either way — only who says yes changes"
            checked={settings.autoPost}
            disabled={!canManage || !settings.enabled}
            onChange={(v) => void save({ autoPost: v })}
          />
          <button
            className="btn btn-primary"
            disabled={!canManage || busy || !readiness.ok}
            onClick={() => void scan()}
          >
            <Search size={15} /> {busy ? 'Looking…' : 'Look for a comment'}
          </button>
        </div>
      </section>

      {!readiness.ok && <div className="alert alert-warning">{readiness.reason}</div>}
      {error && <div className="alert alert-error">{error}</div>}
      {notice && <div className="alert alert-info">{notice}</div>}

      <nav className="ck-nav" role="tablist">
        {(
          [
            ['scans', 'Scans', <ListChecks key="i" size={14} />, counts.review ? `${counts.review} to review` : ''],
            ['learned', 'What it learned', <TrendingUp key="i" size={14} />, learning.summary.n ? String(learning.summary.n) : ''],
            ['settings', 'Settings', <SlidersHorizontal key="i" size={14} />, ''],
          ] as [View, string, ReactNode, string][]
        ).map(([id, label, icon, extra]) => (
          <button
            key={id}
            role="tab"
            aria-selected={view === id}
            className={`ck-nav-item${view === id ? ' active' : ''}`}
            onClick={() => setView(id)}
          >
            {icon} {label}
            {extra && <span className="ck-nav-count">{extra}</span>}
          </button>
        ))}
      </nav>

      {/* ── Scans ── */}
      {view === 'scans' && (
        <section className="ck-section">
          {loaded && rows.length > 0 && (
            <div className="ck-seg" role="radiogroup" aria-label="Show">
              {(
                [
                  ['review', 'Needs review', counts.review],
                  ['inflight', 'On its way', counts.inflight],
                ] as [Filter, string, number][]
              ).map(([id, label, n]) => (
                <button
                  key={id}
                  role="radio"
                  aria-checked={filter === id}
                  className={filter === id ? 'active' : ''}
                  onClick={() => setFilter(id)}
                >
                  {label} <span className="ck-seg-count">{n}</span>
                </button>
              ))}
            </div>
          )}
          {!loaded ? (
            <p className="ck-empty">Loading…</p>
          ) : rows.length === 0 ? (
            <div className="ck-empty">
              <Search size={18} />
              <p>
                No scans yet. Each scan looks in one Comment-tagged community, reads up to{' '}
                {settings.maxThreadsPerScan} thread{settings.maxThreadsPerScan === 1 ? '' : 's'} in full, and either
                writes one comment or records why it did not.
              </p>
            </div>
          ) : shown.length === 0 ? (
            <p className="ck-empty">
              {filter === 'review' ? 'Nothing waiting for review.' : 'Nothing on its way.'} Posted, rejected and
              nothing-found scans are on the account&apos;s Dashboard and in Accounts → Activity.
            </p>
          ) : (
            <ul className="scan-list">
              {shown.map((row) => {
                // Same window the enqueue will use, not the default — otherwise
                // the panel calls a draft stale that the server will happily post.
                const fresh = draftFreshness(row.thread, nowMs, settings.limits);
                return (
                  <CommentScanCard
                    key={row.draftId}
                    row={row}
                    job={jobs[row.draftId]}
                    stale={fresh.stale}
                    threadAgeHours={fresh.threadAgeHours}
                    nowMs={nowMs}
                    canManage={canManage}
                    note={note[row.draftId] ?? ''}
                    onNote={(v) => setNote((n) => ({ ...n, [row.draftId]: v }))}
                    onReview={(action) => void review(row.draftId, action)}
                  />
                );
              })}
            </ul>
          )}
        </section>
      )}

      {/* ── What it learned ── */}
      {view === 'learned' && (
        <section className="card ck-section">
          <div className="card-head">
            <div>
              <h3>What it learned</h3>
              <p className="ck-lede">
                Posted comments are measured at about 1 hour, 1 day and 3 days. Nothing is adjusted until about
                twenty have been measured.
              </p>
            </div>
            <button className="btn btn-secondary btn-sm" disabled={!canManage || sweeping} onClick={() => void sweep()}>
              <TrendingUp size={14} /> {sweeping ? 'Checking…' : 'Check outcomes'}
            </button>
          </div>

          {learning.summary.n === 0 ? (
            <div className="ck-empty">
              <TrendingUp size={18} />
              <p>No measured comments yet. Press Check outcomes once comments have been up for an hour — each check is a billed read.</p>
            </div>
          ) : (
            <>
              <div className="ck-stats">
                <div className="ck-stat">
                  <span>Measured</span>
                  <b>{learning.summary.n}</b>
                </div>
                <div className="ck-stat">
                  <span>Median score</span>
                  <b>{learning.summary.medianScore}</b>
                </div>
                <div className="ck-stat">
                  <span>Removed</span>
                  <b className={learning.summary.removed ? 'text-error' : ''}>{learning.summary.removed}</b>
                </div>
                <div className="ck-stat">
                  <span>Against the scorer</span>
                  <b>{learning.summary.exploratory}</b>
                </div>
              </div>

              {learning.summary.bySubreddit.length > 0 && (
                <div className="table-container" style={{ marginTop: 16 }}>
                  <table>
                    <thead>
                      <tr>
                        <th>Community</th>
                        <th>Comments</th>
                        <th>Median score</th>
                        <th>In view</th>
                        <th>Got a reply</th>
                        <th>Removed</th>
                        <th>Weight</th>
                      </tr>
                    </thead>
                    <tbody>
                      {learning.summary.bySubreddit.map((b) => (
                        <tr key={b.key}>
                          <td>r/{b.key}</td>
                          <td>{b.n}</td>
                          <td>{b.medianScore}</td>
                          <td>{Math.round(b.topHalfRate * 100)}%</td>
                          <td>{Math.round(b.replyRate * 100)}%</td>
                          <td className={b.removedRate > 0 ? 'text-error' : ''}>{Math.round(b.removedRate * 100)}%</td>
                          <td>{learning.knobs.communityWeights[b.key] ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {learning.summary.byGapState.length > 0 && (
                <div className="scan-facts" style={{ marginTop: 14 }}>
                  {learning.summary.byGapState.map((b) => (
                    <span key={b.key} className="scan-fact">
                      {GAP_STATE_SHORT[b.key] ?? b.key}: <b>{b.n}</b> · median <b>{b.medianScore}</b>
                      {learning.knobs.gapConfidenceFloor[b.key as keyof typeof learning.knobs.gapConfidenceFloor] !==
                        undefined && ' · now needs more confidence'}
                    </span>
                  ))}
                </div>
              )}

              {learning.knobs.notes.length > 0 && (
                // Why a knob moved. Behaviour changing for reasons the UI never
                // explains is how an operator stops trusting the tool.
                <div className="ck-notes">
                  <h4>What changed, and why</h4>
                  <ul>
                    {learning.knobs.notes.map((n, i) => (
                      <li key={i}>{n}</li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </section>
      )}

      {/* ── Settings ── */}
      {view === 'settings' && (
        <section className="card ck-settings">
          <SettingRow
            title="Finding posts"
            lede="Where a scan looks for threads."
            more={
              <>
                <p>
                  <strong>Reddit&rsquo;s own feed</strong> reads what someone opening the community sees, in
                  Reddit&rsquo;s order — free and keyword-free, but it can only judge posts by age before paying to
                  read them. <strong>Keyword search</strong> costs one billed call but returns full details, so most
                  candidates are dropped for free; it only finds what a keyword covers.
                </p>
                <p>
                  One feed is picked per scan. <strong>Rising</strong> matters most: it finds a thread while there is
                  still room at the top. <strong>Hot</strong> is more crowded; <strong>new</strong> is mostly too
                  young to judge.
                </p>
              </>
            }
          >
            <div className="ck-seg" role="radiogroup" aria-label="How to find posts">
              {(
                [
                  ['feed', 'Reddit’s own feed'],
                  ['search', 'Keyword search'],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  role="radio"
                  aria-checked={settings.discovery === id}
                  className={settings.discovery === id ? 'active' : ''}
                  disabled={!canManage}
                  onClick={() => void save({ discovery: id })}
                >
                  {label}
                </button>
              ))}
            </div>
            {settings.discovery === 'feed' && (
              <>
                <div className="ck-field-label">Feeds to use</div>
                <div className="ck-pills">
                  {LISTING_FEEDS.map((feed) => {
                    const on = settings.feeds.includes(feed);
                    return (
                      <button
                        key={feed}
                        aria-pressed={on}
                        className={`ck-pill${on ? ' active' : ''}`}
                        disabled={!canManage}
                        onClick={() =>
                          void save({ feeds: on ? settings.feeds.filter((f) => f !== feed) : [...settings.feeds, feed] })
                        }
                      >
                        {on && <Check size={12} />} {feed[0].toUpperCase() + feed.slice(1)}
                      </button>
                    );
                  })}
                </div>
                <Switch
                  label="Match the age window to each community’s pace"
                  hint="Recommended. A fast community and a slow one need different windows; your Oldest post setting still caps it."
                  checked={settings.adaptWindow}
                  disabled={!canManage}
                  onChange={(v) => void save({ adaptWindow: v })}
                />
              </>
            )}
          </SettingRow>

          <SettingRow
            title="Who this account is"
            lede="Fixed, not made up per comment. Claim only what this person could know."
          >
            <div className="ck-grid ck-grid-2">
              <label className="field ck-span-2">
                <span>Situation</span>
                <textarea
                  rows={2}
                  defaultValue={settings.persona.situation}
                  disabled={!canManage}
                  placeholder="renting in Manchester, works shifts, into cycling"
                  onBlur={(e) => void save({ persona: { ...settings.persona, situation: e.target.value } })}
                />
              </label>
              <label className="field">
                <span>Knows about</span>
                <input
                  defaultValue={words(settings.persona.topics)}
                  disabled={!canManage}
                  placeholder="budgeting, renting, cycling"
                  onBlur={(e) => void save({ persona: { ...settings.persona, topics: parseList(e.target.value) } })}
                />
                <small>Separate with commas</small>
              </label>
              <label className="field">
                <span>Must never claim to be</span>
                <input
                  defaultValue={words(settings.persona.neverClaims)}
                  disabled={!canManage}
                  placeholder="a doctor, a lawyer, a parent"
                  onBlur={(e) =>
                    void save({ persona: { ...settings.persona, neverClaims: parseList(e.target.value) } })
                  }
                />
                <small>Separate with commas</small>
              </label>
              <label className="field ck-span-2">
                <span>Never mention</span>
                <input
                  defaultValue={words(settings.bannedTerms)}
                  disabled={!canManage}
                  placeholder="brands, clients, domains"
                  onBlur={(e) => void save({ bannedTerms: parseList(e.target.value) })}
                />
                <small>This account never names a brand — that is what keeps it separate from client work.</small>
              </label>
            </div>
          </SettingRow>

          <SettingRow
            title="Threads worth entering"
            lede="Starting guesses, not measurements. Widen them to see more candidates."
            more={
              <p>
                Read why threads are passed over in a scan&rsquo;s Steps: <em>so many comments</em> or{' '}
                <em>too far ahead</em> means these are tighter than the community; <em>too new</em> or{' '}
                <em>too old</em> means the age window is wrong for how fast it moves; <em>already arguing</em> means
                the upvote-ratio bar is catching ordinary disagreement.
              </p>
            }
          >
            <div className="ck-grid ck-grid-3">
              {limitFields.map(([key, label, help]) => (
                <label key={key} className="field">
                  <span>{label}</span>
                  <input
                    type="number"
                    step={key === 'minUpvoteRatio' ? 0.05 : 1}
                    defaultValue={settings.limits[key]}
                    disabled={!canManage}
                    onBlur={(e) => void save({ limits: { ...settings.limits, [key]: decimal(e.target.value) } })}
                  />
                  <small>{help}</small>
                </label>
              ))}
            </div>
          </SettingRow>

          <SettingRow
            title="Limits"
            lede="Kept apart from the account’s posting cap, so warm-up comments never use up client replies."
          >
            <div className="ck-grid ck-grid-3">
              {railFields.map(([key, label, help, min, max]) => (
                <label key={key} className="field">
                  <span>{label}</span>
                  <input
                    type="number"
                    min={min}
                    max={max}
                    defaultValue={settings[key] as number}
                    disabled={!canManage}
                    onBlur={(e) => void save({ [key]: Number(e.target.value) } as Partial<CommentKarmaSettings>)}
                  />
                  <small>{help}</small>
                </label>
              ))}
            </div>
          </SettingRow>

          <SettingRow
            title="Testing switches"
            lede="Force a scan past its own judgement, to try what comes after. Turn off when done."
            more={
              <p>
                No switch reaches a post that is an image, a link, locked, archived, pinned, NSFW, quarantined,
                removed or in contest mode, or the checks on the comment itself. Those are facts about the post, and
                relaxing them would only find ways to get the account banned.
              </p>
            }
          >
            {relaxed && (
              <div className="alert alert-warning" style={{ marginBottom: 12 }}>
                Switches are on. Comments made this way are marked, are never approved automatically, and may be
                filler.
              </div>
            )}
            <div className="ck-switches">
              {relaxFields.map(([key, label, help]) => (
                <Switch
                  key={key}
                  label={label}
                  hint={help}
                  checked={settings.relax[key]}
                  disabled={!canManage}
                  onChange={(v) => void save({ relax: { ...settings.relax, [key]: v } })}
                />
              ))}
            </div>
          </SettingRow>
        </section>
      )}
    </div>
  );
}

type View = 'scans' | 'learned' | 'settings';
type Filter = 'review' | 'inflight';

/** A toggle — a checkbox underneath, so it keeps keyboard and form behaviour. */
function Switch({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className={`ck-switch${disabled ? ' is-disabled' : ''}`}>
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="ck-switch-track" aria-hidden />
      <span className="ck-switch-text">
        <span>{label}</span>
        {hint && <small>{hint}</small>}
      </span>
    </label>
  );
}

/** One settings group: what it is on the left, its controls on the right. */
function SettingRow({
  title,
  lede,
  more,
  children,
}: {
  title: string;
  lede: string;
  more?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="ck-setting">
      <div className="ck-setting-about">
        <h4>{title}</h4>
        <p>{lede}</p>
        {more && (
          <details className="ck-more">
            <summary>Read more</summary>
            {more}
          </details>
        )}
      </div>
      <div className="ck-setting-controls">{children}</div>
    </div>
  );
}
