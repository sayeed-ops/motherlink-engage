'use client';

import { useState, type ReactNode } from 'react';
import { BookOpen, Check, ListOrdered, Lightbulb, Route, X, Ban, ExternalLink } from 'lucide-react';
import { SKIP_STAGE_LABEL, type CommentDraftRecord } from '@/modules/forum/reply/drafts';
import {
  CHECK_LABEL,
  GAP_STATE_SHORT,
  WANT_LABEL,
  confidenceLabel,
  explainTraceLine,
} from '@/modules/forum/reply/explain';
import { renderRedditMarkdown } from '@/modules/reddit/redditMarkdown';
import ApproachPlanView from '@/components/ApproachPlanView';
import type { CommentJobView } from '@/server/commentKarmaJobs';

// One comment karma scan, as a card.
//
// What a reviewer needs first is on the face of it: what was found, the
// comment, the few facts that decide whether it fits, and the buttons. Every
// "why" is one click away in a tab, so the list stays scannable — a stack of
// fully expanded records is what made the old one unreadable.
//
//   The post   the thread's own text — what the comment is answering
//   Why        what the thread was missing, and why this draft was picked
//   Steps      the scan step by step, in plain words (technical on request)
//   Approach   how the agent reaches the thread and posts it, once queued
//   Refused    drafts the automatic checks turned down, and why

type Tab = 'post' | 'why' | 'steps' | 'approach' | 'refused';

const STATUS: Record<string, { label: string; cls: string }> = {
  pending: { label: 'Needs review', cls: '' },
  approved: { label: 'Approved', cls: 'badge-info' },
  queued: { label: 'Queued', cls: 'badge-info' },
  posted: { label: 'Posted', cls: 'badge-success' },
  rejected: { label: 'Rejected', cls: '' },
  skipped: { label: 'No comment', cls: 'badge-no-dot' },
};

function ago(ms: number, nowMs: number): string {
  const min = Math.max(0, Math.round((nowMs - ms) / 60_000));
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export default function CommentScanCard({
  row,
  job,
  stale,
  threadAgeHours,
  nowMs,
  canManage,
  note,
  onNote,
  onReview,
}: {
  row: CommentDraftRecord;
  /** The job behind it, once queued. Undefined before that. */
  job?: CommentJobView;
  stale: boolean;
  threadAgeHours: number;
  nowMs: number;
  canManage: boolean;
  note: string;
  onNote: (value: string) => void;
  onReview: (action: 'approve' | 'reject' | 'queue') => void;
}) {
  const [tab, setTab] = useState<Tab | null>(null);
  const [technical, setTechnical] = useState(false);
  const toggle = (t: Tab) => setTab((cur) => (cur === t ? null : t));

  const failed = row.skipStage === 'error';
  const status = failed ? { label: 'Could not run', cls: 'badge-error' } : STATUS[row.status] ?? { label: row.status, cls: '' };
  const produced = !!row.text;
  const thread = row.thread;
  const posting = job?.status === 'posting';

  const tabs: { id: Tab; label: string; icon: ReactNode; count?: number }[] = [
    ...(thread ? [{ id: 'post' as const, label: 'The post', icon: <BookOpen size={13} /> }] : []),
    ...(row.gap || row.criticReason ? [{ id: 'why' as const, label: 'Why', icon: <Lightbulb size={13} /> }] : []),
    ...(row.trace.length ? [{ id: 'steps' as const, label: 'Steps', icon: <ListOrdered size={13} />, count: row.trace.length }] : []),
    ...(produced && row.status !== 'rejected'
      ? [{ id: 'approach' as const, label: 'Approach', icon: <Route size={13} /> }]
      : []),
    ...(row.rejected.length
      ? [{ id: 'refused' as const, label: 'Refused', icon: <Ban size={13} />, count: row.rejected.length }]
      : []),
  ];

  return (
    <li className={`scan-card${produced ? '' : ' is-skipped'}`}>
      <div className="scan-head">
        <span className={`badge ${status.cls}`}>{posting ? 'Posting' : status.label}</span>
        {thread && <span className="scan-sub">r/{thread.subreddit}</span>}
        {row.status === 'posted' && row.permalink && (
          <a href={row.permalink} target="_blank" rel="noreferrer" className="small">
            See it on Reddit <ExternalLink size={11} style={{ verticalAlign: '-1px' }} />
          </a>
        )}
        <span className="scan-when" title={new Date(row.createdAtMs).toLocaleString()}>
          {ago(row.createdAtMs, nowMs)}
        </span>
      </div>

      {thread && (
        <a className="scan-title" href={thread.threadUrl} target="_blank" rel="noreferrer">
          {thread.title}
        </a>
      )}

      {produced ? (
        <>
          <blockquote className="scan-quote">{row.text}</blockquote>
          <div className="scan-facts">
            <span className="scan-fact">
              <b>{row.words}</b> words
            </span>
            {row.room && row.room.sampleSize > 0 && (
              <span className="scan-fact" title="The typical length of the well-upvoted comments in this thread">
                good comments here ≈ <b>{row.room.medianWinnerWords}</b> words
              </span>
            )}
            {row.gap && (
              <span className="scan-fact">
                poster wants <b>{WANT_LABEL[row.gap.posterWant] ?? row.gap.posterWant}</b>
              </span>
            )}
            {row.gap && (
              <span className="scan-fact" title="Whether the useful thing has already been said in the thread">
                the point is <b>{GAP_STATE_SHORT[row.gap.gapState] ?? row.gap.gapState}</b>
              </span>
            )}
            {row.autoApproved && <span className="scan-fact">approved automatically</span>}
            {row.outcome.checks.map((c, i) => (
              <span key={i} className="scan-fact" title="How the comment was doing when it was checked">
                after {c.ageHours}h: <b>{c.score}</b> pts, #{c.rank} of {c.totalTopLevel}
              </span>
            ))}
          </div>
        </>
      ) : (
        <p className="scan-skip">
          <strong>{row.skipStage ? SKIP_STAGE_LABEL[row.skipStage] : 'Skipped'}.</strong> {row.skipReason}
        </p>
      )}

      {row.relaxed && produced && (
        <div className="alert alert-warning">
          Made with a testing switch on, so it may be filler — it was not approved automatically.
        </div>
      )}
      {row.exploratory && (
        <div className="alert alert-info">Taken against the scorer&rsquo;s advice, to test the rules.</div>
      )}
      {stale && produced && (row.status === 'pending' || row.status === 'approved') && (
        <div className="alert alert-error">
          The thread is {Math.round(threadAgeHours)}h old — past the window this comment was written for. Posted
          now, it would land below the fold.
        </div>
      )}
      {row.outcome.removed && (
        <div className="alert alert-error">
          Gone from the thread — removed or deleted. That is the room rejecting the account, not a low score.
        </div>
      )}
      {row.releaseReason && <div className="alert alert-error">{row.releaseReason}</div>}
      {job?.error && job.status === 'failed' && <div className="alert alert-error">The agent failed: {job.error}</div>}
      {row.reviewNote && <p className="scan-pane-note" style={{ marginTop: 8 }}>Your note: {row.reviewNote}</p>}

      {row.status === 'pending' && canManage && (
        <div className="scan-review">
          <input
            className="small"
            placeholder="Why? (optional — kept as training data)"
            value={note}
            onChange={(e) => onNote(e.target.value)}
          />
          <button className="btn btn-primary btn-sm" onClick={() => onReview('approve')}>
            <Check size={14} /> Approve
          </button>
          <button className="btn btn-secondary btn-sm" onClick={() => onReview('reject')}>
            <X size={14} /> Reject
          </button>
        </div>
      )}
      {row.status === 'approved' && canManage && (
        <div className="scan-review">
          <span className="scan-pane-note" style={{ flex: 1 }}>
            Approved, not queued — a posting rule held it back, and most of those expire.
          </span>
          <button className="btn btn-secondary btn-sm" onClick={() => onReview('queue')}>
            Queue it
          </button>
        </div>
      )}

      {tabs.length > 0 && (
        <div className="scan-tabs" role="tablist">
          {tabs.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className={`scan-tab${tab === t.id ? ' active' : ''}`}
              onClick={() => toggle(t.id)}
            >
              {t.icon} {t.label}
              {t.count ? <span className="scan-count">{t.count}</span> : null}
            </button>
          ))}
        </div>
      )}

      {tab === 'post' && thread && (
        <div className="scan-pane">
          {thread.body === undefined ? (
            <p className="scan-pane-note">
              Scans before 16 October saved only the title.{' '}
              <a href={thread.threadUrl} target="_blank" rel="noreferrer">
                Read the post on Reddit
              </a>
              .
            </p>
          ) : thread.body.trim() ? (
            <div
              className="reddit-preview"
              // Escaped first, then a closed set of tags — see redditMarkdown.ts.
              dangerouslySetInnerHTML={{ __html: renderRedditMarkdown(thread.body) }}
            />
          ) : (
            <p className="scan-pane-note">
              The post has no text, only its title — it may be an image, video or link.{' '}
              <a href={thread.threadUrl} target="_blank" rel="noreferrer">
                Open it on Reddit
              </a>
              .
            </p>
          )}
        </div>
      )}

      {tab === 'why' && (
        <div className="scan-pane">
          <dl className="scan-why">
            {row.gap && (
              <>
                <dt>Missing</dt>
                <dd>
                  {row.gap.angle}{' '}
                  <span className="text-dim">({confidenceLabel(row.gap.confidence)} sure)</span>
                </dd>
              </>
            )}
            {row.criticReason && (
              <>
                <dt>{produced ? 'Why this one' : 'Why none'}</dt>
                <dd>{row.criticReason}</dd>
              </>
            )}
          </dl>
        </div>
      )}

      {tab === 'steps' && (
        <div className="scan-pane">
          <div className="scan-pane-head">
            <span className="scan-pane-note">What the scan did, in order. Hover a step for its exact wording.</span>
            <button className="btn btn-ghost btn-sm" onClick={() => setTechnical((v) => !v)}>
              {technical ? 'Plain wording' : 'Technical wording'}
            </button>
          </div>
          <ol className={`scan-steps${technical ? ' is-technical' : ''}`}>
            {row.trace.map((t, i) => {
              const line = t.trim();
              const cls = line.startsWith('stop:') || line.startsWith('error:') ? 'is-stop' : line.startsWith('chose a') ? 'is-pick' : '';
              return (
                <li key={i} className={cls} title={t}>
                  {technical ? line : explainTraceLine(t)}
                </li>
              );
            })}
          </ol>
        </div>
      )}

      {tab === 'approach' && (
        <div className="scan-pane">
          {job && (job.approachPlan.length > 0 || job.approachTrace.length > 0) ? (
            <ApproachPlanView
              plan={job.approachPlan}
              trace={job.approachTrace}
              browse={job.browse}
              firstVisit={job.firstVisit}
              compact
            />
          ) : row.status === 'queued' || row.status === 'posted' ? (
            <p className="scan-pane-note">No route was recorded for this one.</p>
          ) : (
            <p className="scan-pane-note">
              The route is planned when the comment is queued — how the account browses first, reaches the
              subreddit and the post, and what it reads before typing.
            </p>
          )}
        </div>
      )}

      {tab === 'refused' && (
        <div className="scan-pane">
          <ul className="scan-refused">
            {row.rejected.map((r, i) => (
              <li key={i}>
                <q>{r.text}</q>
                <div className="scan-facts">
                  {r.failures.map((f, j) => (
                    <span key={j} className="scan-fact" title={`${f.code}: ${f.detail}`}>
                      {CHECK_LABEL[f.code] ?? f.code}
                    </span>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </li>
  );
}
