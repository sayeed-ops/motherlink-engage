'use client';

import { useEffect, useMemo, useState } from 'react';
import { Dices, TrendingUp, History, PlayCircle } from 'lucide-react';
import WarmupLoopView from './WarmupLoopView';
import { subscribe, q } from '@/lib/data';
import {
  composeWarmupSession,
  upvoteChanceForDay,
  normalizeWarmupTrace,
  DEFAULT_POLICY,
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
  startedAtMs,
  canManage,
}: {
  accountId: string;
  /** Subreddits the account can plausibly open directly. */
  subreddits: string[];
  /** When this account's warm-up began. Drives the day the ramp is evaluated at. */
  startedAtMs: number | null;
  canManage: boolean;
}) {
  const derivedDay = startedAtMs ? Math.max(1, Math.floor((Date.now() - startedAtMs) / 86_400_000) + 1) : 1;

  const [day, setDay] = useState(derivedDay);
  const [curve, setCurve] = useState(DEFAULT_POLICY.upvoteCurve);
  const [nonce, setNonce] = useState(0);
  const [runs, setRuns] = useState<WarmupRunRow[] | null>(null);
  const [openRun, setOpenRun] = useState<string | null>(null);
  const [queueing, setQueueing] = useState(false);
  const [queued, setQueued] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** Queue ONE session for the agent to run.
   *
   *  The plan is re-composed server-side, not taken from the preview above —
   *  what runs must be what was recorded, and the agent re-rolls nothing. So the
   *  queued session will differ from the one on screen, which is correct. */
  async function runNow() {
    setQueueing(true);
    setError(null);
    setQueued(null);
    try {
      const res = await fetch(`/api/accounts/${accountId}/warmup/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ day, subreddits }),
      });
      const json = await res.json();
      if (!res.ok) setError(json.error || 'Could not queue the session.');
      else setQueued(json.jobId);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not queue the session.');
    } finally {
      setQueueing(false);
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

  const policy: WarmupPolicy = useMemo(
    () => ({ ...DEFAULT_POLICY, upvoteCurve: curve, subreddits, searchTargets: subreddits }),
    [curve, subreddits],
  );

  // Re-composed whenever anything changes. `nonce` is what the re-roll button
  // bumps — a new seed, same policy.
  const session: WarmupLoopSession = useMemo(
    () => composeWarmupSession({ day, policy, seed: nonce ? undefined : 20260812 }),
    [day, policy, nonce],
  );

  /** Ten sessions at this day, to show the SPREAD rather than one lucky sample.
   *  One session tells you nothing about whether the walk looks human; ten tell
   *  you almost everything. */
  const spread = useMemo(() => {
    const rows = Array.from({ length: 10 }, (_, i) => composeWarmupSession({ day, policy, seed: 900_001 + i + nonce * 97 }));
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
              <button className="btn primary" onClick={runNow} disabled={queueing}>
                <PlayCircle size={14} style={{ verticalAlign: '-2px' }} /> {queueing ? 'Queueing…' : 'Run one now'}
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
            Queued. The agent picks it up within a poll (~5s) and it will appear under <strong>Sessions run</strong> when
            it finishes. The queued walk is composed fresh on the server, so it will not match the one below — that is
            deliberate.
          </p>
        )}
        <p className="text-dim small" style={{ marginTop: 0 }}>
          Composed in your browser, right now. The agent runs exactly this list — every random choice is already
          resolved, so nothing is re-rolled at run time.
          {subreddits.length === 0 && (
            <> This account follows no subreddits yet, so the walk can only enter via Home, r/popular and r/news.</>
          )}
        </p>

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
