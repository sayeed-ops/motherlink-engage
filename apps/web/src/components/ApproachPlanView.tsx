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
  Target,
  BookOpen,
  MessagesSquare,
  ArrowBigUp,
  PenLine,
  CircleDashed,
} from 'lucide-react';
import {
  APPROACH_LABELS,
  describeApproachStep,
  describeApproachOutcome,
  approachStepCaveat,
  estimateApproachSeconds,
  type ApproachActionType,
  type ApproachPlan,
  type ApproachTrace,
} from '@/modules/reddit/approach';

// The approach plan / the approach taken, read-only.
//
// Before the agent runs, this is the itinerary: land on the home feed, search out
// the subreddit, browse, find the post, read it, maybe skim comments, maybe
// upvote, then comment. It is decided once when the reply is queued and frozen
// onto the job, so it is exactly what will run — not a description of what usually
// happens. Afterwards the same list shows what actually happened, from the trace
// the agent writes back.
//
// Deliberately NOT editable. The plan's value is that it is generated fresh and
// differently every time; hand-tuning it would pull every account back onto the
// same path, which is the pattern the whole design exists to avoid.

const ICONS: Record<ApproachActionType, ReactNode> = {
  open_home: <Home size={13} />,
  search_subreddit: <Search size={13} />,
  open_subreddit: <Users2 size={13} />,
  scroll_feed: <ScrollText size={13} />,
  find_target: <Target size={13} />,
  read_post: <BookOpen size={13} />,
  skim_comments: <MessagesSquare size={13} />,
  upvote_post: <ArrowBigUp size={13} />,
  upvote_comment: <ArrowBigUp size={13} />,
  post_comment: <PenLine size={13} />,
};

function fmtGap(sec: number): string {
  if (!sec) return '';
  return sec < 1 ? '<1s' : `${sec % 1 === 0 ? sec : sec.toFixed(1)}s`;
}

function fmtTotal(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (!m) return `${s}s`;
  return s < 10 ? `${m} min` : `${m} min ${s}s`;
}

type StepState = 'done' | 'skipped' | 'failed' | 'pending';

function stateOf(trace: ApproachTrace[number] | undefined, ran: boolean): StepState {
  if (!ran || !trace) return 'pending';
  if (!trace.ok) return 'failed';
  if (trace.skipped) return 'skipped';
  return 'done';
}

const STATE_COLOR: Record<StepState, string> = {
  done: 'var(--success, #16a34a)',
  failed: 'var(--error, #dc2626)',
  skipped: 'var(--text-dim)',
  pending: 'var(--text-dim)',
};

/** The icon medallion, with a status ring once the step has run. */
function StepMarker({ type, state }: { type: ApproachActionType; state: StepState }) {
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

export default function ApproachPlanView({
  plan,
  trace = [],
  compact = false,
}: {
  plan: ApproachPlan;
  /** What actually happened, once the agent has run. Empty until then. */
  trace?: ApproachTrace;
  /** Tighter padding, for the account Dashboard's activity list. */
  compact?: boolean;
}) {
  if (!plan.length && !trace.length) return null;

  const ran = trace.length > 0;
  const estimate = estimateApproachSeconds(plan);
  const actual = trace.reduce((sum, t) => sum + (t.elapsedSec ?? 0), 0);
  // A plan we can't see (very old job) still renders from the trace alone.
  const rows: { type: ApproachActionType; detail: string; gapAfterSec: number; caveat: string }[] = plan.length
    ? plan.map((s) => ({
        type: s.type,
        detail: describeApproachStep(s),
        gapAfterSec: s.gapAfterSec,
        caveat: approachStepCaveat(s),
      }))
    : trace.map((t) => ({ type: t.type, detail: '', gapAfterSec: 0, caveat: '' }));

  return (
    <div className="bordered" style={{ marginTop: 8, padding: compact ? 12 : 18, marginBottom: 0 }}>
      <div className="row between" style={{ marginBottom: 10 }}>
        <span className="eyebrow-muted">{ran ? 'Approach taken' : 'Approach plan'}</span>
        <span className="text-muted small">
          <Clock size={11} style={{ verticalAlign: '-1px' }} />{' '}
          {ran && actual > 0 ? `took ${fmtTotal(actual)}` : `about ${fmtTotal(estimate)}`}
        </span>
      </div>

      <ol style={{ margin: 0, padding: 0, listStyle: 'none' }}>
        {rows.map((row, i) => {
          const t = trace[i]?.type === row.type ? trace[i] : trace.find((x) => x.type === row.type);
          const state = stateOf(t, ran);
          const outcome = t ? describeApproachOutcome(t) : '';
          const last = i === rows.length - 1;
          return (
            <li key={`${row.type}-${i}`} style={{ display: 'flex', gap: 10 }}>
              {/* marker + the line that threads the steps together */}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0 }}>
                <StepMarker type={row.type} state={state} />
                {!last && <span style={{ flex: 1, width: 1, background: 'var(--border)', minHeight: 12 }} />}
              </div>

              <div style={{ flex: 1, paddingBottom: last ? 0 : 12, minWidth: 0 }}>
                <div className="row between" style={{ gap: 8, alignItems: 'baseline' }}>
                  <span className="small" style={{ fontWeight: 500 }}>
                    {APPROACH_LABELS[row.type] ?? row.type}
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

                {row.detail && (
                  <div className="text-muted small" style={{ marginTop: 1 }}>
                    {row.detail}
                  </div>
                )}

                {/* Before the run: flag the steps reality can overrule. */}
                {!ran && row.caveat && (
                  <div style={{ marginTop: 3 }}>
                    <span
                      className="badge badge-no-dot badge-warning"
                      style={{ fontSize: 10.5 }}
                      title={row.caveat}
                    >
                      may change
                    </span>{' '}
                    <span className="text-faint small">{row.caveat}</span>
                  </div>
                )}

                {/* After the run: what actually happened. */}
                {outcome && (
                  <div
                    className={state === 'failed' ? 'text-error small' : 'small'}
                    style={{ marginTop: 3, color: state === 'done' ? 'var(--success, #16a34a)' : undefined }}
                  >
                    {outcome}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      <p className="text-faint small" style={{ margin: '10px 0 0' }}>
        {ran
          ? 'The route this reply was actually posted through, kept with the job for good.'
          : 'Generated when this reply was queued, and different every time — the route through search, the reading time, how many comments get read, and whether anything is upvoted are all decided per reply.'}
      </p>
    </div>
  );
}
