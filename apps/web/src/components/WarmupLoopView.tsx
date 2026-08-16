'use client';

import type { ReactNode } from 'react';
import {
  Clock,
  Check,
  X,
  Minus,
  Home,
  Search,
  Users2,
  ScrollText,
  MousePointerClick,
  BookOpen,
  MessagesSquare,
  ArrowBigUp,
  CircleDashed,
  CornerDownRight,
  TextSearch,
  UserPlus,
} from 'lucide-react';
import {
  WARMUP_LOOP_LABELS,
  describeWarmupStep,
  warmupStepCaveat,
  estimateWarmupSeconds,
  summarizeWarmupRun,
  STOP_REASON_LABEL,
  ANCHOR_TYPES,
  type WarmupLoopActionType,
  type WarmupLoopPlan,
  type WarmupTrace,
  type WarmupStopReason,
} from '@/modules/reddit/warmupWalk';

// One warm-up session — the itinerary before it runs, and what actually happened
// after. The posting twin is ApproachPlanView; this deliberately reads the same
// so an operator learns one thing, not two.
//
// The difference worth showing is that a warm-up session has an INTENT the
// posting flow does not: a vote budget, drawn from the day's ramp before the walk
// starts. "Allowed 1, placed 1" is the line that tells you the ramp is working;
// "allowed 1, placed 0" on a real run is the first sign a selector has drifted.
//
// Read-only, like the approach view. The value of a generated session is that it
// is different every time; hand-editing one pulls every account back onto the
// same path, which is the whole thing this design exists to avoid.

const ICONS: Record<WarmupLoopActionType, ReactNode> = {
  open_feed: <Home size={13} />,
  open_subreddit: <Users2 size={13} />,
  search_subreddit: <Search size={13} />,
  search_keyword: <TextSearch size={13} />,
  join_subreddit: <UserPlus size={13} />,
  scroll_feed: <ScrollText size={13} />,
  open_feed_post: <MousePointerClick size={13} />,
  open_post_subreddit: <CornerDownRight size={13} />,
  read_post: <BookOpen size={13} />,
  skim_comments: <MessagesSquare size={13} />,
  upvote_post: <ArrowBigUp size={13} />,
  upvote_comment: <ArrowBigUp size={13} />,
};

function fmtGap(sec: number): string {
  if (!sec) return '';
  return sec < 1 ? '<1s' : `${sec % 1 === 0 ? sec : sec.toFixed(1)}s`;
}

function fmtTotal(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  if (!m) return `${s}s`;
  return s < 10 ? `${m} min` : `${m} min ${s}s`;
}

type StepState = 'done' | 'skipped' | 'failed' | 'pending';

function stateOf(t: WarmupTrace[number] | undefined, ran: boolean): StepState {
  if (!ran || !t) return 'pending';
  if (!t.ok) return 'failed';
  if (t.skipped) return 'skipped';
  return 'done';
}

const STATE_COLOR: Record<StepState, string> = {
  done: 'var(--success, #16a34a)',
  failed: 'var(--error, #dc2626)',
  skipped: 'var(--text-dim)',
  pending: 'var(--text-dim)',
};

/** Route names the agent reports, in the operator's words rather than the code's.
 *  Unknown values fall through unchanged — a new route must never render blank. */
const VIA_LABEL: Record<string, string> = {
  typeahead: 'the search suggestions',
  communities: 'the Communities tab',
  communities_tab: 'the Communities tab',
  posts: 'a post in the results',
  post_result: 'a post in the results',
  'results-return': 'the earlier results',
  // NOT "a search by name" — it is a page.goto. Naming it accurately matters
  // because this is the one outcome that means the discovery leg failed and the
  // account teleported: the keyword never surfaced the community.
  'name-fallback': 'a direct visit — the topic search never surfaced it',
  'direct-fallback': 'a direct visit',
};

/** What the agent reported for a step, in words. */
function describeOutcome(t: WarmupTrace[number]): string {
  if (!t.ok) return t.reason ? `Failed — ${t.reason}` : 'Failed';
  if (t.skipped) {
    const why: Record<string, string> = {
      // Shared by upvote_post, read_post and open_post_subreddit — all three
      // refuse to act when the earlier step in their leg failed to open a
      // thread, so this must not name any one of them.
      'not-on-thread': 'was not on a post page — the earlier step in this leg did not open one',
      'already-upvoted': 'already upvoted; left alone',
      'empty-feed': 'the feed had no posts',
      'no-title-link': 'the card had no title link',
      'click-missed': 'the click did not land',
      'did-not-open': 'the click did not open a thread',
      'no-community-name': 'the post did not say which community it is in',
      'no-community-link': 'no clickable link to the community on this post',
      'did-not-land': 'the click did not reach that community',
      'already-on-thread': 'already on a thread',
    };
    return `Skipped — ${(t.reason && why[t.reason]) || t.reason || 'nothing to do here'}`;
  }
  if (t.dryRun) return 'Dry run — would have done it, did not click';
  if (t.upvoted === true) return 'Upvoted';
  if (typeof t.read === 'number' && typeof t.available === 'number') {
    return `Read ${t.read} of ${t.available} comment${t.available === 1 ? '' : 's'}`;
  }
  if (typeof t.seconds === 'number' && t.seconds > 0) return `Spent ${t.seconds}s`;
  // A RECOVERY IS NOT THE SAME AS GOING THE PLANNED WAY, and it used to render
  // identically — the agent logged "recovered via X" but the trace carried only
  // the route that landed, so the screen said `Via communities` whether that was
  // the intention or the third thing it tried. A surface that has quietly
  // stopped working stays invisible that way until it fails everywhere at once.
  if (t.via && t.plannedVia && t.plannedVia !== t.via) {
    return `Via ${VIA_LABEL[t.via] ?? t.via} — the planned ${VIA_LABEL[t.plannedVia] ?? t.plannedVia} route did not surface it`;
  }
  if (t.via) return `Via ${VIA_LABEL[t.via] ?? t.via}`;
  return '';
}

function StepMarker({ type, state }: { type: WarmupLoopActionType; state: StepState }) {
  const color = STATE_COLOR[state];
  const badge =
    state === 'done' ? <Check size={9} /> : state === 'failed' ? <X size={9} /> : state === 'skipped' ? <Minus size={9} /> : null;
  return (
    <span style={{ position: 'relative', display: 'inline-flex', flexShrink: 0 }}>
      <span
        style={{
          width: 26,
          height: 26,
          borderRadius: '50%',
          border: `1px solid ${state === 'pending' ? 'var(--border)' : color}`,
          background: 'var(--surface-1)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: state === 'pending' ? 'var(--text-muted)' : color,
          opacity: state === 'skipped' ? 0.6 : 1,
        }}
      >
        {ICONS[type] ?? <CircleDashed size={13} />}
      </span>
      {badge && (
        <span
          style={{
            position: 'absolute',
            right: -3,
            bottom: -3,
            width: 13,
            height: 13,
            borderRadius: '50%',
            background: color,
            color: 'var(--surface-1)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {badge}
        </span>
      )}
    </span>
  );
}

export default function WarmupLoopView({
  plan,
  trace = [],
  day,
  upvoteChance,
  upvoteBudget,
  stoppedBy,
  compact = false,
}: {
  plan: WarmupLoopPlan;
  /** What actually happened. Empty until the agent has run it. */
  trace?: WarmupTrace;
  day?: number;
  /** The day's ramp value that produced the budget. */
  upvoteChance?: number;
  /** How many votes this session was allowed. */
  upvoteBudget?: number;
  stoppedBy?: WarmupStopReason;
  compact?: boolean;
}) {
  if (!plan.length && !trace.length) return null;

  const ran = trace.length > 0;
  const estimate = estimateWarmupSeconds(plan);
  const actual = trace.reduce((sum, t) => sum + (t.elapsedSec ?? 0), 0);
  const s = summarizeWarmupRun(plan, trace);
  const plannedVotes = plan.filter((p) => p.type === 'upvote_post' || p.type === 'upvote_comment').length;

  return (
    <div className="bordered" style={{ marginTop: 8, padding: compact ? 12 : 18, marginBottom: 0 }}>
      <div className="row between" style={{ marginBottom: 4 }}>
        <span className="eyebrow-muted">{ran ? 'Session taken' : 'Session plan'}</span>
        <span className="text-muted small">
          <Clock size={11} style={{ verticalAlign: '-1px' }} />{' '}
          {ran && actual > 0 ? `took ${fmtTotal(actual)}` : `about ${fmtTotal(estimate)}`}
        </span>
      </div>

      {/* The intent line. This is what makes the ramp legible: on day 1 most
          sessions say "allowed 0", by day 5 most say "allowed 1". */}
      <p className="text-dim small" style={{ margin: '0 0 12px' }}>
        {typeof day === 'number' && <>Day {day}</>}
        {typeof upvoteChance === 'number' && (
          <> · {Math.round(upvoteChance * 100)}% chance of a vote today</>
        )}
        {typeof upvoteBudget === 'number' && (
          <>
            {' '}
            · allowed {upvoteBudget}, planned {plannedVotes}
            {ran && <>, placed {s.upvoted}</>}
          </>
        )}
        {plan.length > 0 && <> · {plan.length} steps</>}
      </p>

      <ol style={{ margin: 0, padding: 0, listStyle: 'none' }}>
        {(plan.length ? plan : trace.map((t) => ({ type: t.type as WarmupLoopActionType, params: {}, gapAfterSec: 0, jitterPct: 0 }))).map(
          (row, i) => {
            const t = trace[i]?.type === row.type ? trace[i] : undefined;
            const state = stateOf(t, ran);
            const outcome = t ? describeOutcome(t) : '';
            const detail = plan.length ? describeWarmupStep(row) : '';
            const caveat = plan.length ? warmupStepCaveat(row) : '';
            const last = i === (plan.length || trace.length) - 1;
            const isAnchor = ANCHOR_TYPES.has(row.type);
            return (
              <li key={`${row.type}-${i}`} style={{ display: 'flex', gap: 10 }}>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0 }}>
                  <StepMarker type={row.type} state={state} />
                  {!last && <span style={{ flex: 1, width: 1, background: 'var(--border)', minHeight: 12 }} />}
                </div>

                <div style={{ flex: 1, paddingBottom: last ? 0 : 12, minWidth: 0 }}>
                  <div className="row between" style={{ gap: 8, alignItems: 'baseline' }}>
                    <span className="small" style={{ fontWeight: 500 }}>
                      {WARMUP_LOOP_LABELS[row.type] ?? row.type}
                      {/* Anchors are the recovery points. Worth marking: they are
                          why a step that skipped cannot derail the whole session. */}
                      {isAnchor && i > 0 && (
                        <span className="text-faint small" style={{ fontWeight: 400 }}>
                          {' '}
                          · starts fresh here
                        </span>
                      )}
                    </span>
                    <span
                      className="text-faint small"
                      style={{ fontFamily: 'var(--font-geist-mono), monospace', whiteSpace: 'nowrap' }}
                    >
                      {ran
                        ? typeof t?.elapsedSec === 'number' && t.elapsedSec > 0
                          ? `${t.elapsedSec}s`
                          : ''
                        : row.gapAfterSec > 0
                          ? `then waits ${fmtGap(row.gapAfterSec)}`
                          : ''}
                    </span>
                  </div>

                  {detail && (
                    <p className="text-dim small" style={{ margin: '2px 0 0' }}>
                      {detail}
                    </p>
                  )}
                  {outcome && (
                    <p
                      className="small"
                      style={{ margin: '2px 0 0', color: state === 'failed' ? STATE_COLOR.failed : 'var(--text-muted)' }}
                    >
                      {outcome}
                    </p>
                  )}
                  {!ran && caveat && (
                    <p className="text-faint small" style={{ margin: '2px 0 0', fontStyle: 'italic' }}>
                      {caveat}
                    </p>
                  )}
                </div>
              </li>
            );
          },
        )}
      </ol>

      {/* The session ends where it ends. Saying so stops "it just stopped" from
          reading as a bug — truncation is the behaviour, not a failure. */}
      {stoppedBy && (
        <p className="text-faint small" style={{ margin: '12px 0 0', fontStyle: 'italic' }}>
          {STOP_REASON_LABEL[stoppedBy]} — the session simply ends here, with no tidy sign-off. That is the point.
        </p>
      )}

      {ran && (
        <p className="text-dim small" style={{ margin: '10px 0 0' }}>
          {s.ran} of {s.planned} step{s.planned === 1 ? '' : 's'} ran
          {s.skipped > 0 && <> · {s.skipped} skipped</>}
          {s.failed > 0 && <> · {s.failed} failed</>}
          {' · '}
          {s.upvoted} upvote{s.upvoted === 1 ? '' : 's'} placed
        </p>
      )}
    </div>
  );
}
