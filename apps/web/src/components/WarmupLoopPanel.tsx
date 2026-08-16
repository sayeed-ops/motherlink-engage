'use client';

import { useEffect, useMemo, useState } from 'react';
import { Dices, TrendingUp, History, PlayCircle, Ban } from 'lucide-react';
import WarmupLoopView from './WarmupLoopView';
import { subscribe, q } from '@/lib/data';
import { apiPost, ApiError } from '@/lib/api';
import {
  composeWarmupSession,
  upvoteChanceForDay,
  normalizeWarmupTrace,
  warmupExperienceDay,
  warmupBoldnessDay,
  STOP_REASON_LABEL,
  type WarmupPolicy,
  type WarmupLoopSession,
  type WarmupLoopPlan,
  type WarmupStopReason,
} from '@/modules/reddit/warmupWalk';

// The warm-up LOOP tab — separate from the package designer on purpose.
//
// The designer composes days out of fixed packages. That is a fine way to
// hand-author a schedule and a bad way to look human: a package always runs to
// completion, so every session ends at a package boundary, and its probabilities
// are hardcoded so day 1 and day 30 behave identically.
//
// This tab is the other model. A session is a WALK, composed fresh each time from
// a policy, with a vote chance that ramps across days and a session that simply
// stops mid-scroll. Nothing here is hand-editable, which is the point — the value
// is that no two sessions are alike.
//
// Everything below runs IN THE BROWSER. composeWarmupSession is pure, which is
// what makes tuning possible: change a number, hit re-roll, read the result. No
// server, no agent, no Reddit.

interface WarmupRunRow {
  id: string;
  runId?: string;
  jobId?: string;
  day?: number | null;
  plan?: unknown;
  trace?: unknown;
  planned?: number;
  ran?: number;
  skipped?: number;
  failed?: number;
  upvoted?: number;
  /** Votes the plan intended but a dry run withheld. */
  wouldUpvote?: number;
  dryRun?: boolean;
  ranAt?: { seconds: number } | null;
}

function fmtWhen(ts: WarmupRunRow['ranAt']): string {
  if (!ts?.seconds) return '';
  const d = new Date(ts.seconds * 1000);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function WarmupLoopPanel({
  accountId,
  subreddits,
  joinTargets,
  keywords,
  keywordPairs,
  savedPolicy,
  startedAtMs,
  sessionsCompleted,
  canManage,
}: {
  accountId: string;
  /** Subreddits the account can plausibly open directly. */
  subreddits: string[];
  /** THE LIST-SHAPED FIELDS MUST BE PASSED IN, not read off the saved policy.
   *
   *  They are derived from the community list at compose time and deliberately
   *  NOT stored on the policy (a second copy would drift). The run route derives
   *  them; if this panel did not, it would preview a session with no joins while
   *  the server composed one with joins — the same seed producing two different
   *  plans, which is precisely the §4b guarantee this file exists to keep. */
  joinTargets: string[];
  keywords: string[];
  keywordPairs: Record<string, string[]>;
  /** The account's SAVED policy — the same base the run route composes from.
   *
   *  Previously this panel always started from DEFAULT_POLICY while the server
   *  merged the account's stored policy on top. Identical only while nothing
   *  wrote a policy; the moment one existed, the same seed would have produced a
   *  different plan on each side and "the session you previewed is the session
   *  that runs" would have broken with nothing to show for it. */
  savedPolicy: WarmupPolicy;
  /** When this account's warm-up began. Drives the AGE clock. */
  startedAtMs: number | null;
  /** Sessions actually completed. Drives the EXPERIENCE clock. */
  sessionsCompleted: number;
  canManage: boolean;
}) {
  // Two clocks — must match the run route, or the preview would open on a
  // different day than the session that runs.
  const ageDay = startedAtMs ? Math.max(1, Math.floor((Date.now() - startedAtMs) / 86_400_000) + 1) : 1;
  const experienceDay = warmupExperienceDay(sessionsCompleted);
  const derivedDay = warmupBoldnessDay(ageDay, sessionsCompleted);

  const [day, setDay] = useState(derivedDay);
  const [curve, setCurve] = useState(savedPolicy.upvoteCurve);
  // SEEDED RANDOMLY PER PAGE LOAD — do not put this back to 0.
  //
  // `nonce` used to start at 0, and at 0 the preview below composed from a
  // HARDCODED seed. So an operator who opened this page and pressed "Run one
  // now" without touching re-roll got the SAME WALK EVERY TIME: same step
  // order, same scroll bursts, same read durations, same feed positions. Two
  // sessions four hours apart on 2026-08-15 came out byte-identical, which is
  // how this was found — the only thing that differed was the community name.
  //
  // Worse than repetitive: the constant does not depend on the account either,
  // so every account on the same warm-up day and policy walked the identical
  // session. Two accounts behaving identically is a CROSS-ACCOUNT correlation
  // signal, and cross-account correlation is the one failure the per-IP profile
  // design exists to prevent — a stronger tell than any single odd session.
  //
  // The constant was there for a real reason: Math.random() during render is
  // impure and would break hydration. A lazy useState initializer solves that
  // properly — it runs once, on mount, and this panel only ever mounts on the
  // client (the page renders "Loading…" until the Firestore snapshot arrives,
  // so it never renders on the server). Stable within a page load, which the
  // 50-session spread below depends on; different on every load.
  const [nonce, setNonce] = useState(() => 1 + Math.floor(Math.random() * 1_000_000));
  const [runs, setRuns] = useState<WarmupRunRow[] | null>(null);
  const [openRun, setOpenRun] = useState<string | null>(null);
  const [queueing, setQueueing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [queued, setQueued] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** Queue ONE session for the agent to run.
   *
   *  The plan is re-composed server-side rather than taken from the preview, so
   *  the route never trusts a client-supplied step list — but it is composed
   *  from THIS session's seed, so what runs is exactly what is on screen.
   *  Composition is deterministic, which is what makes the seed sufficient. */
  async function runNow() {
    setQueueing(true);
    setError(null);
    setQueued(null);
    try {
      // apiPost, NOT a bare fetch. Every route handler requires a bearer token —
      // there is no unauthenticated path into this API, which is the single
      // biggest difference from ML Studio. A raw fetch() here failed with
      // "Missing bearer token", and it went unnoticed because every test session
      // until now was queued through the Admin SDK from the CLI, which bypasses
      // the auth layer entirely.
      // Send the SEED of the session on screen, not the plan. Composition is
      // deterministic, so the server rebuilds this exact walk from a validated
      // policy — what you previewed is what runs, without trusting a
      // client-supplied step list.
      const res = await apiPost<{ jobId: string }>(`/api/accounts/${accountId}/warmup/run`, {
        // BROWSE ONLY. This tab can never queue a session that joins, however
        // many communities are tagged Follow — that is the Communities tab's
        // job. An earlier version had one shared session type and this button
        // queued a real join nobody asked for.
        kind: 'browse',
        day,
        subreddits,
        seed: session.seed,
        curve,
      });
      setQueued(res.jobId);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'Could not queue the session.');
    } finally {
      setQueueing(false);
    }
  }

  /** Release a session that is queued or stuck. Restarting the agent mid-run
   *  leaves a job claimed forever from the app's side, and every later run is
   *  then refused with no way forward. Warm-up jobs only. */
  async function cancelInFlight() {
    setCancelling(true);
    setError(null);
    setQueued(null);
    try {
      const res = await apiPost<{ message: string }>(`/api/accounts/${accountId}/warmup/cancel`, {});
      setError(null);
      setQueued(res.message);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'Could not cancel.');
    } finally {
      setCancelling(false);
    }
  }

  useEffect(() => {
    const unsub = subscribe<WarmupRunRow>(
      q.warmupRuns(accountId),
      (rows) => setRuns(rows),
      () => setRuns([]),
    );
    return unsub;
  }, [accountId]);

  // Must mirror the run route's `composed` object exactly.
  const policy: WarmupPolicy = useMemo(
    () => ({
      ...savedPolicy,
      upvoteCurve: curve,
      subreddits,
      searchTargets: subreddits,
      joinTargets,
      keywords,
      keywordsByCommunity: keywordPairs,
    }),
    [savedPolicy, curve, subreddits, joinTargets, keywords, keywordPairs],
  );

  // Re-composed whenever anything changes. `nonce` is what the re-roll button
  // bumps — a new seed, same policy.
  //
  // The seed is derived FROM the nonce rather than left undefined, so the
  // preview is stable across re-renders within one page load: an undefined seed
  // re-rolls on every recompute, and this memo recomputes whenever any slider
  // moves. What runs is what is on screen, so the preview drifting under the
  // operator between looking and pressing Run is the same class of bug as the
  // one §4b of WARMUP-LOOP.md was written about.
  const session: WarmupLoopSession = useMemo(
    () => composeWarmupSession({ day, policy, seed: nonce * 2_654_435_761, kind: 'browse' }),
    [day, policy, nonce],
  );

  /** Ten sessions at this day, to show the SPREAD rather than one lucky sample.
   *  One session tells you nothing about whether the walk looks human; ten tell
   *  you almost everything. */
  const spread = useMemo(() => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      composeWarmupSession({ day, policy, seed: 900_001 + i + nonce * 97, kind: 'browse' }),
    );
    const voted = rows.filter((r) => r.upvotesPlanned > 0).length;
    return { rows, voted };
  }, [day, policy, nonce]);

  const num = (v: string, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <section className="card">
        <div className="card-head">
          <h3>
            <TrendingUp size={15} style={{ verticalAlign: '-2px' }} /> The ramp
          </h3>
        </div>
        <p className="text-dim small" style={{ marginTop: 0 }}>
          How likely a single browsing session is to contain an upvote. Per <em>session</em> — not per step and not per
          post, so day {curve.days} works out at roughly one vote per session, a few per day. Defaults are an example;
          every number here is yours to change.
        </p>

        {/* TWO CLOCKS. Age runs on the calendar and never pauses; experience only
            advances when a session actually completes. Boldness takes the lower,
            so an account cannot act older than it is OR more experienced than it
            earned. Shown explicitly because the gap between them was previously
            invisible — an account idle for a week was handed day-8 confidence
            having run three sessions, and nothing on screen said so. */}
        <div className="bordered" style={{ padding: 10, margin: '0 0 12px' }}>
          <p className="text-dim small" style={{ margin: 0 }}>
            <strong>Day {derivedDay}</strong> — age {ageDay} (calendar) · experience {experienceDay} (
            {sessionsCompleted} session{sessionsCompleted === 1 ? '' : 's'} run). Boldness takes the lower of the two.
            {experienceDay < ageDay && (
              <>
                {' '}
                This account is <strong>behind its age</strong>: it is being held at day {derivedDay} until more sessions
                run, rather than acting established without the history to match.
              </>
            )}
          </p>
        </div>

        <div className="row" style={{ gap: 14, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label className="small" style={{ display: 'grid', gap: 4 }}>
            Day 1 chance
            <input
              type="number"
              min={0}
              max={100}
              step={1}
              value={Math.round(curve.pMin * 100)}
              onChange={(e) => setCurve({ ...curve, pMin: num(e.target.value, 10) / 100 })}
              style={{ width: 90 }}
            />
          </label>
          <label className="small" style={{ display: 'grid', gap: 4 }}>
            Final chance
            <input
              type="number"
              min={0}
              max={100}
              step={1}
              value={Math.round(curve.pMax * 100)}
              onChange={(e) => setCurve({ ...curve, pMax: num(e.target.value, 90) / 100 })}
              style={{ width: 90 }}
            />
          </label>
          <label className="small" style={{ display: 'grid', gap: 4 }}>
            Over days
            <input
              type="number"
              min={1}
              max={60}
              value={curve.days}
              onChange={(e) => setCurve({ ...curve, days: Math.round(num(e.target.value, 5)) })}
              style={{ width: 90 }}
            />
          </label>
          <label className="small" style={{ display: 'grid', gap: 4 }}>
            Steepness
            <input
              type="number"
              min={0.1}
              max={12}
              step={0.5}
              value={curve.steepness}
              onChange={(e) => setCurve({ ...curve, steepness: num(e.target.value, 6) })}
              style={{ width: 90 }}
            />
          </label>
        </div>

        {/* The curve, as the numbers it will actually use. More useful than a
            chart: these are the values, day by day. */}
        <div className="row" style={{ gap: 6, marginTop: 14, flexWrap: 'wrap' }}>
          {Array.from({ length: Math.min(curve.days, 14) }, (_, i) => i + 1).map((d) => (
            <button
              key={d}
              onClick={() => setDay(d)}
              className={d === day ? 'chip active' : 'chip'}
              style={{ cursor: 'pointer', border: '1px solid var(--border)', background: d === day ? 'var(--surface-2)' : 'none' }}
            >
              <span className="small">
                d{d} · {Math.round(upvoteChanceForDay(d, curve) * 100)}%
              </span>
            </button>
          ))}
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h3>
            <Dices size={15} style={{ verticalAlign: '-2px' }} /> A session on day {day}
          </h3>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn" onClick={() => setNonce((n) => n + 1)}>
              Re-roll
            </button>
            {canManage && (
              <button className="btn" onClick={cancelInFlight} disabled={cancelling} title="Release a queued or stuck session">
                <Ban size={14} style={{ verticalAlign: '-2px' }} /> {cancelling ? 'Cancelling…' : 'Cancel'}
              </button>
            )}
            {canManage && (
              <button className="btn primary" onClick={runNow} disabled={queueing}>
                <PlayCircle size={14} style={{ verticalAlign: '-2px' }} />{' '}
                {queueing ? 'Queueing…' : 'Run a session'}
              </button>
            )}
          </div>
        </div>

        {error && (
          <p className="small" style={{ color: 'var(--error, #dc2626)', marginTop: 0 }}>
            {error}
          </p>
        )}
        {queued && (
          <p className="small" style={{ color: 'var(--success, #16a34a)', marginTop: 0 }}>
            Queued — <strong>this exact session</strong>. The agent picks it up within a poll (~5s) and it will appear
            under <strong>Sessions run</strong> when it finishes.
          </p>
        )}
        <p className="text-dim small" style={{ marginTop: 0 }}>
          Composed in your browser, right now. The agent runs exactly this list — every random choice is already
          resolved, so nothing is re-rolled at run time.
          {subreddits.length === 0 && (
            <> This account follows no subreddits yet, so the walk can only enter via Home, r/popular and r/news.</>
          )}
        </p>

        {/* A browsing roll browses. It cannot join, cannot search out a
            community it does not already follow, and cannot comment — those are
            other tabs' rolls. This assertion is here because the composer used
            to have a single session type and this tab queued a real join nobody
            asked for; if it ever regresses, it should be loud. */}
        {session.joinsPlanned.length > 0 && (
          <div className="bordered" style={{ padding: 10, marginBottom: 12, borderColor: 'var(--error, #dc2626)' }}>
            <p className="small" style={{ margin: 0, color: 'var(--error, #dc2626)' }}>
              <strong>Bug:</strong> a browsing session composed a join ({session.joinsPlanned.join(', ')}). It should
              not be able to. Do not run this — report it.
            </p>
          </div>
        )}

        <WarmupLoopView
          plan={session.plan}
          day={session.day}
          upvoteChance={session.upvoteChance}
          upvoteBudget={session.upvoteBudget}
          stoppedBy={session.stoppedBy}
        />

        <div className="bordered" style={{ marginTop: 12, padding: 12 }}>
          <span className="eyebrow-muted">Ten more, for the spread</span>
          <p className="text-dim small" style={{ margin: '6px 0 8px' }}>
            {spread.voted} of 10 contain an upvote — target is {Math.round(upvoteChanceForDay(day, curve) * 100)}%.
            One session proves nothing; the spread is what tells you whether it reads as a person.
          </p>
          <ol style={{ margin: 0, paddingLeft: 18 }}>
            {spread.rows.map((r, i) => (
              <li key={i} className="text-dim small" style={{ marginBottom: 2 }}>
                {r.plan.length} steps · ~{Math.round(r.estimatedSec / 60)} min ·{' '}
                {r.upvotesPlanned ? `${r.upvotesPlanned} upvote${r.upvotesPlanned === 1 ? '' : 's'}` : 'no upvote'} ·{' '}
                {STOP_REASON_LABEL[r.stoppedBy as WarmupStopReason]}
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h3>
            <History size={15} style={{ verticalAlign: '-2px' }} /> Sessions run
          </h3>
        </div>
        {runs === null ? (
          <p className="text-dim small">Loading…</p>
        ) : runs.length === 0 ? (
          <p className="text-dim small" style={{ marginTop: 0 }}>
            Nothing has run yet. Once a warm-up session is queued and the agent picks it up, each run lands here with
            what it planned and what it actually managed — the same plan-versus-reality view the posting flow uses.
          </p>
        ) : (
          <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 8 }}>
            {runs.map((r) => {
              const failed = (r.failed ?? 0) > 0;
              const partial = (r.skipped ?? 0) > 0;
              return (
                <li key={r.id} className="bordered" style={{ padding: 12 }}>
                  <div className="row between" style={{ gap: 8, alignItems: 'baseline' }}>
                    <span className="small" style={{ fontWeight: 500 }}>
                      {r.day ? `Day ${r.day}` : 'Session'} · {fmtWhen(r.ranAt)}
                      {r.dryRun && <span className="text-faint"> · dry run</span>}
                    </span>
                    <button
                      className="btn-quiet small"
                      onClick={() => setOpenRun(openRun === r.id ? null : r.id)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer' }}
                    >
                      {openRun === r.id ? 'Hide' : 'Details'}
                    </button>
                  </div>
                  <p
                    className="small"
                    style={{ margin: '4px 0 0', color: failed ? 'var(--error, #dc2626)' : 'var(--text-muted)' }}
                  >
                    {r.ran ?? 0} of {r.planned ?? 0} steps
                    {partial && <> · {r.skipped} skipped</>}
                    {failed && <> · {r.failed} failed</>}
                    {' · '}
                    {/* A dry run places nothing by design. Showing "0 upvotes"
                        for it would read as a broken selector, which is exactly
                        the signal that has to stay meaningful. */}
                    {r.dryRun
                      ? `${r.wouldUpvote ?? 0} vote${(r.wouldUpvote ?? 0) === 1 ? '' : 's'} withheld (dry run)`
                      : `${r.upvoted ?? 0} upvote${(r.upvoted ?? 0) === 1 ? '' : 's'}`}
                  </p>
                  {openRun === r.id && (
                    <WarmupLoopView
                      plan={(Array.isArray(r.plan) ? r.plan : []) as WarmupLoopPlan}
                      trace={normalizeWarmupTrace(r.trace)}
                      day={r.day ?? undefined}
                      compact
                    />
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
