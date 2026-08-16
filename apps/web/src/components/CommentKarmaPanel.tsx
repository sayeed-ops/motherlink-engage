'use client';

import { useEffect, useMemo, useState } from 'react';
import { collection, limit, orderBy, query } from 'firebase/firestore';
import { Check, ChevronDown, ChevronRight, Search, TrendingUp, X } from 'lucide-react';
import { db } from '@/lib/firebase/config';
import { subscribe } from '@/lib/data';
import { apiFetch, ApiError } from '@/lib/api';
import {
  draftFreshness,
  normalizeDraft,
  SKIP_STAGE_LABEL,
  type CommentDraftRecord,
} from '@/modules/reddit/commentKarma/drafts';
import { fitKnobs, summarise, toSamples } from '@/modules/reddit/commentKarma/learn';
import { LISTING_FEEDS } from '@/modules/reddit/reader/discovery';
import {
  normalizeCommentSettings,
  scanReadiness,
  type CommentKarmaSettings,
  type CommunityKeywords,
} from '@/modules/reddit/commentKarma/settings';

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
  canManage: boolean;
}

function words(list: string[]): string {
  return list.join(', ');
}

function parseList(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export default function CommentKarmaPanel({ accountId, saved, pairs, canManage }: Props) {
  const [settings, setSettings] = useState<CommentKarmaSettings>(() => normalizeCommentSettings(saved));
  const [rows, setRows] = useState<CommentDraftRecord[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [note, setNote] = useState<Record<string, string>>({});
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

  const readiness = useMemo(() => scanReadiness(settings, pairs), [settings, pairs]);
  const pending = rows.filter((r) => r.status === 'pending');

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
      setSettings(normalizeCommentSettings(saved));
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

  return (
    <>
      <section className="card">
        <div className="card-head">
          <h3>Comment karma</h3>
        </div>
        <p className="text-dim small">
          Low-stakes, ordinary comments that build a comment history worth having, placed in the communities
          tagged <strong>Comment</strong>. It looks for a <em>gap</em> — what a thread wants and has not got —
          and copies its length and register from the comments already winning there.{' '}
          <strong>Most scans produce nothing, and that is the design:</strong> a system that always finds
          something to say posts filler, and filler is what gets an account spotted.
        </p>
        <p className="text-dim small">
          <strong>Approving queues it.</strong> The agent opens this account&rsquo;s browser profile, browses to
          the thread the way a person would, and posts the comment. It is checked again on the way out — a
          stale thread, the daily cap, or a comment already made in that community today will hold it back, and
          the panel says which.
        </p>

        <div className="row" style={{ gap: 16, flexWrap: 'wrap' }}>
          <label className="small">
            <input
              type="checkbox"
              checked={settings.enabled}
              disabled={!canManage}
              onChange={(e) => void save({ enabled: e.target.checked })}
            />{' '}
            Enabled for this account
          </label>
          <label className="small">
            <input
              type="checkbox"
              checked={settings.autoPost}
              disabled={!canManage || !settings.enabled}
              onChange={(e) => void save({ autoPost: e.target.checked })}
            />{' '}
            Approve automatically (no review)
          </label>
        </div>
        <p className="text-dim small">
          Auto and reviewed run the <em>same</em> pipeline and the same checks — the switch only decides who
          says yes at the end.
        </p>
      </section>

      <section className="card">
        <div className="card-head">
          <h3>How it finds posts</h3>
        </div>
        <p className="text-dim small">
          <strong>Reddit&rsquo;s own feed</strong> reads what someone opening that community would actually
          see, in the order Reddit shows it — including the thread taking off right now for reasons nobody
          typed into a settings box. It is free and needs no keywords, but it can only screen on age, so more
          of the paid thread reads turn out to be rejects.{' '}
          <strong>Keyword search</strong> costs one billed call and comes back with full metadata, so most
          candidates are discarded for free — but it can only ever find what a keyword covers.
        </p>
        <div className="row" style={{ gap: 16, flexWrap: 'wrap' }}>
          <label className="small">
            <input
              type="radio"
              checked={settings.discovery === 'feed'}
              disabled={!canManage}
              onChange={() => void save({ discovery: 'feed' })}
            />{' '}
            Reddit&rsquo;s own feed
          </label>
          <label className="small">
            <input
              type="radio"
              checked={settings.discovery === 'search'}
              disabled={!canManage}
              onChange={() => void save({ discovery: 'search' })}
            />{' '}
            Keyword search
          </label>
        </div>
        {settings.discovery === 'feed' && (
          <>
            <div className="row" style={{ gap: 16, flexWrap: 'wrap' }}>
              {LISTING_FEEDS.map((feed) => (
                <label key={feed} className="small">
                  <input
                    type="checkbox"
                    checked={settings.feeds.includes(feed)}
                    disabled={!canManage}
                    onChange={(e) =>
                      void save({
                        feeds: e.target.checked
                          ? [...settings.feeds, feed]
                          : settings.feeds.filter((f) => f !== feed),
                      })
                    }
                  />{' '}
                  {feed}
                </label>
              ))}
            </div>
            <p className="text-dim small">
              One is picked per scan. <strong>rising</strong> is the one that matters — it finds a thread while
              there is still room at the top, which is the premise the whole selection model rests on.{' '}
              <strong>hot</strong> has already arrived and is more crowded; <strong>new</strong> is mostly too
              young to judge.
            </p>
          </>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h3>Who this account is</h3>
        </div>
        <p className="text-dim small">
          Fixed, not regenerated per comment. Only claim what this person could actually know — a persona that
          never overclaims can never be caught out.
        </p>
        <label className="field">
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
          <span>Knows about (comma separated)</span>
          <input
            defaultValue={words(settings.persona.topics)}
            disabled={!canManage}
            placeholder="budgeting, renting, cycling"
            onBlur={(e) => void save({ persona: { ...settings.persona, topics: parseList(e.target.value) } })}
          />
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
        </label>
        <label className="field">
          <span>Never mention (brands, clients, domains)</span>
          <input
            defaultValue={words(settings.bannedTerms)}
            disabled={!canManage}
            onBlur={(e) => void save({ bannedTerms: parseList(e.target.value) })}
          />
          <span className="text-dim small">
            This account carries no narrative. A brand mention here is the whole reason comment karma and the
            growth pipeline share no code.
          </span>
        </label>
      </section>

      <section className="card">
        <div className="card-head">
          <h3>Rails</h3>
        </div>
        <p className="text-dim small">
          Separate from the account&rsquo;s posting cap on purpose — spending the posting budget on warm-up
          comments would starve the thing the account exists for.
        </p>
        <div className="row" style={{ gap: 16, flexWrap: 'wrap' }}>
          <label className="field" style={{ maxWidth: 160 }}>
            <span>Comments per day</span>
            <input
              type="number"
              min={1}
              max={20}
              defaultValue={settings.dailyCap}
              disabled={!canManage}
              onBlur={(e) => void save({ dailyCap: Number(e.target.value) })}
            />
          </label>
          <label className="field" style={{ maxWidth: 180 }}>
            <span>Minimum gap (minutes)</span>
            <input
              type="number"
              min={15}
              max={1440}
              defaultValue={settings.minIntervalMinutes}
              disabled={!canManage}
              onBlur={(e) => void save({ minIntervalMinutes: Number(e.target.value) })}
            />
          </label>
          <label className="field" style={{ maxWidth: 200 }}>
            <span>Combined ceiling (per day)</span>
            <input
              type="number"
              min={1}
              max={30}
              defaultValue={settings.combinedDailyCap}
              disabled={!canManage}
              onBlur={(e) => void save({ combinedDailyCap: Number(e.target.value) })}
            />
            <span className="text-dim small">
              Replies and comments together. Someone reading the profile sees total activity.
            </span>
          </label>
          <label className="field" style={{ maxWidth: 200 }}>
            <span>Per community (per day)</span>
            <input
              type="number"
              min={1}
              max={5}
              defaultValue={settings.maxPerSubredditPerDay}
              disabled={!canManage}
              onBlur={(e) => void save({ maxPerSubredditPerDay: Number(e.target.value) })}
            />
          </label>
          <label className="field" style={{ maxWidth: 200 }}>
            <span>Threads read per scan</span>
            <input
              type="number"
              min={1}
              max={8}
              defaultValue={settings.maxThreadsPerScan}
              disabled={!canManage}
              onBlur={(e) => void save({ maxThreadsPerScan: Number(e.target.value) })}
            />
            <span className="text-dim small">Every read is a billed call, including one for a deleted post.</span>
          </label>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h3>What it has learned</h3>
          <button className="btn" disabled={!canManage || sweeping} onClick={() => void sweep()}>
            <TrendingUp size={14} style={{ verticalAlign: '-2px' }} /> {sweeping ? 'Checking…' : 'Check outcomes'}
          </button>
        </div>
        <p className="text-dim small">
          Every posted comment is measured at about 1h, 1d and 3d — score, rank among the top-level comments,
          replies. Each check is a billed read, so it happens when you press this. Until roughly twenty
          comments have been measured, <strong>nothing is fitted</strong>: a knob tuned to three data points is
          worse than no knob. Figures cover the most recent {MAX_ROWS} scans; the list below shows {LIST_ROWS}.
        </p>

        {learning.summary.n === 0 ? (
          <p className="text-dim small">No measured comments yet.</p>
        ) : (
          <>
            <p className="small">
              <strong>{learning.summary.n}</strong> measured · median <strong>{learning.summary.medianScore}</strong>{' '}
              point(s)
              {learning.summary.removed > 0 && (
                <span className="text-error"> · {learning.summary.removed} removed</span>
              )}
              {learning.summary.exploratory > 0 && (
                <span className="text-dim"> · {learning.summary.exploratory} taken against the scorer&rsquo;s advice</span>
              )}
            </p>

            {learning.summary.bySubreddit.length > 0 && (
              <ul className="small text-dim" style={{ margin: '4px 0' }}>
                {learning.summary.bySubreddit.map((b) => (
                  <li key={b.key}>
                    r/{b.key} — {b.n} comment(s), median {b.medianScore}, {Math.round(b.topHalfRate * 100)}% in the
                    visible half, {Math.round(b.replyRate * 100)}% got a reply
                    {b.removedRate > 0 && `, ${Math.round(b.removedRate * 100)}% removed`}
                    {learning.knobs.communityWeights[b.key] !== undefined &&
                      ` · weight ${learning.knobs.communityWeights[b.key]}`}
                  </li>
                ))}
              </ul>
            )}

            {learning.summary.byGapState.length > 0 && (
              <ul className="small text-dim" style={{ margin: '4px 0' }}>
                {learning.summary.byGapState.map((b) => (
                  <li key={b.key}>
                    {b.key} — {b.n} comment(s), median {b.medianScore}
                    {learning.knobs.gapConfidenceFloor[b.key as keyof typeof learning.knobs.gapConfidenceFloor] !==
                      undefined && ` · now needs higher confidence`}
                  </li>
                ))}
              </ul>
            )}

            {learning.knobs.notes.length > 0 && (
              <>
                {/* Why a knob moved. Behaviour changing for reasons the UI never
                    explains is how an operator stops trusting the tool. */}
                <p className="text-dim small">
                  <strong>What changed, and why:</strong>
                </p>
                <ul className="small text-dim">
                  {learning.knobs.notes.map((n, i) => (
                    <li key={i}>{n}</li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h3>Scans</h3>
          <button className="btn primary" disabled={!canManage || busy || !readiness.ok} onClick={() => void scan()}>
            <Search size={14} style={{ verticalAlign: '-2px' }} /> {busy ? 'Looking…' : 'Look for a comment'}
          </button>
        </div>
        {!readiness.ok && <p className="text-dim small">{readiness.reason}</p>}
        {error && <p className="text-error small">{error}</p>}
        {notice && <p className="small">{notice}</p>}
        {pending.length > 0 && (
          <p className="small">
            <strong>{pending.length}</strong> waiting for you.
          </p>
        )}

        {!loaded ? (
          <p className="text-dim small">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-dim small">
            Nothing yet. Each scan searches one Comment-tagged community, reads up to{' '}
            {settings.maxThreadsPerScan} thread(s) in full, and either writes one comment or records why it
            did not.
          </p>
        ) : (
          <ul className="list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {rows.slice(0, LIST_ROWS).map((row) => {
              const fresh = draftFreshness(row.thread, nowMs);
              const isOpen = !!open[row.draftId];
              return (
                <li key={row.draftId} className="bordered" style={{ padding: 12, marginTop: 8 }}>
                  <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
                    <span className="small">
                      <button
                        className="btn-quiet small"
                        onClick={() => setOpen((o) => ({ ...o, [row.draftId]: !isOpen }))}
                        aria-label={isOpen ? 'Collapse' : 'Expand'}
                      >
                        {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      </button>{' '}
                      {row.thread ? (
                        <a href={row.thread.threadUrl} target="_blank" rel="noreferrer">
                          r/{row.thread.subreddit} — {row.thread.title.slice(0, 80)}
                        </a>
                      ) : (
                        <span className="text-dim">no thread</span>
                      )}
                    </span>
                    <span className="badge badge-no-dot">{row.status}</span>
                  </div>

                  {row.text ? (
                    <>
                      <p style={{ whiteSpace: 'pre-wrap', margin: '8px 0' }}>{row.text}</p>
                      <p className="text-dim small">
                        {row.words} words{row.room ? ` · this room runs ${row.room.medianWinnerWords}` : ''}
                        {row.gap ? ` · they want ${row.gap.posterWant} · gap: ${row.gap.gapState}` : ''}
                        {row.autoApproved ? ' · approved automatically' : ''}
                      </p>
                      {fresh.stale && (
                        <p className="text-error small">
                          The thread is {Math.round(fresh.threadAgeHours)}h old — past the window this comment
                          was written for. Posting it now lands below the fold.
                        </p>
                      )}
                    </>
                  ) : (
                    <p className="text-dim small" style={{ margin: '8px 0' }}>
                      {row.skipStage ? SKIP_STAGE_LABEL[row.skipStage] : 'Skipped'} — {row.skipReason}
                    </p>
                  )}

                  {row.status === 'pending' && canManage && (
                    <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                      <input
                        className="small"
                        placeholder="Why? (kept as training data)"
                        value={note[row.draftId] ?? ''}
                        onChange={(e) => setNote((n) => ({ ...n, [row.draftId]: e.target.value }))}
                        style={{ flex: 1, minWidth: 200 }}
                      />
                      <button className="btn primary" onClick={() => void review(row.draftId, 'approve')}>
                        <Check size={14} style={{ verticalAlign: '-2px' }} /> Approve
                      </button>
                      <button className="btn" onClick={() => void review(row.draftId, 'reject')}>
                        <X size={14} style={{ verticalAlign: '-2px' }} /> Reject
                      </button>
                    </div>
                  )}

                  {row.exploratory && (
                    <p className="text-dim small">
                      Taken against the scorer&rsquo;s advice — this one is here to test the rules.
                    </p>
                  )}
                  {row.outcome.checks.length > 0 && (
                    <p className="small">
                      {row.outcome.checks
                        .map((c) => `${c.ageHours}h: ${c.score} pt, rank ${c.rank}/${c.totalTopLevel}`)
                        .join(' · ')}
                    </p>
                  )}
                  {row.outcome.removed && (
                    <p className="text-error small">
                      Gone from the thread — removed or deleted. That is the room rejecting the account, not a low
                      score.
                    </p>
                  )}
                  {row.status === 'posted' && row.permalink && (
                    <p className="small">
                      <a href={row.permalink} target="_blank" rel="noreferrer">
                        Posted — see it on Reddit
                      </a>
                    </p>
                  )}
                  {row.status === 'approved' && canManage && (
                    <div className="row" style={{ gap: 8 }}>
                      <span className="text-dim small" style={{ flex: 1 }}>
                        Approved, not queued. The rails refused it — most reasons expire.
                      </span>
                      <button className="btn" onClick={() => void review(row.draftId, 'queue')}>
                        Queue it
                      </button>
                    </div>
                  )}
                  {row.status === 'queued' && (
                    <p className="text-dim small">
                      Queued. The agent will browse to the thread and post it on its next poll.
                    </p>
                  )}
                  {row.releaseReason && <p className="text-error small">{row.releaseReason}</p>}
                  {row.reviewNote && <p className="text-dim small">Note: {row.reviewNote}</p>}

                  {isOpen && (
                    <div className="small" style={{ marginTop: 8 }}>
                      {row.gap && (
                        <p className="text-dim">
                          <strong>Gap:</strong> {row.gap.angle} (confidence {row.gap.confidence})
                        </p>
                      )}
                      {row.criticReason && (
                        <p className="text-dim">
                          <strong>Critic:</strong> {row.criticReason}
                        </p>
                      )}
                      {row.trace.length > 0 && (
                        <>
                          <p className="text-dim">
                            <strong>What it did:</strong>
                          </p>
                          <ul className="text-dim">
                            {row.trace.map((t, i) => (
                              <li key={i}>{t}</li>
                            ))}
                          </ul>
                        </>
                      )}
                      {row.rejected.length > 0 && (
                        <>
                          <p className="text-dim">
                            <strong>Written and refused:</strong>
                          </p>
                          <ul className="text-dim">
                            {row.rejected.map((r, i) => (
                              <li key={i}>
                                “{r.text.slice(0, 140)}” — {r.failures.map((f) => f.code).join(', ')}
                              </li>
                            ))}
                          </ul>
                        </>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </>
  );
}
