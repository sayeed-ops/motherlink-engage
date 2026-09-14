'use client';

import { useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, ExternalLink, Send } from 'lucide-react';
import { MODE_LABEL } from '@/modules/shopify/modes';
import { tokens, type Draft, type PostJob, type PostingContext } from './types';

/** What the thread screen hands every draft so it can be posted. */
export interface PostingProps {
  context: PostingContext | null;
  jobs: Record<string, PostJob>;
  busyDraftId: string | null;
  onQueue: (draftId: string, accountId: string) => void | Promise<void>;
  onCancel: (jobId: string) => void | Promise<void>;
}

const ACTIVE = new Set(['queued', 'posting']);

/**
 * Posting one approved reply.
 *
 * ⚠️ WHAT THE BUTTON DOES IS SAID NEXT TO IT. With Shopify in dry run the agent
 * opens the thread, checks the account, types the reply and STOPS — the job then
 * ends "failed: dry run", which is the rehearsal succeeding. Live, it submits.
 */
function PostControls({ draft, posting }: { draft: Draft; posting: PostingProps }) {
  const job = posting.jobs[draft.draftId];
  const ctx = posting.context;
  const usable = (ctx?.accounts ?? []).filter((a) => !a.refusal);
  const [accountId, setAccountId] = useState('');
  const chosen = accountId || usable[0]?.accountId || '';
  const busy = posting.busyDraftId === draft.draftId;

  if (draft.status === 'posted' || job?.status === 'posted') {
    const link = draft.postedPermalink || job?.permalink;
    const who = draft.postedByUsername || job?.username;
    return (
      <div className="row small" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
        <span className="badge badge-success">posted</span>
        {who && <span className="text-dim">by @{who}</span>}
        {link && (
          <a href={link} target="_blank" rel="noopener noreferrer">
            View on the community <ExternalLink size={11} aria-hidden />
          </a>
        )}
      </div>
    );
  }

  if (job && ACTIVE.has(job.status)) {
    return (
      <div className="row small" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
        <span className="badge badge-warning">{job.status === 'queued' ? 'queued for the agent' : `posting — ${job.stage || 'working'}`}</span>
        <span className="text-dim">from @{job.username}{ctx?.dryRun ? ' · dry run: it will type and stop' : ''}</span>
        <button className="btn btn-ghost btn-sm" onClick={() => void posting.onCancel(job.jobId)} disabled={busy}>
          Cancel
        </button>
      </div>
    );
  }

  if (draft.status !== 'approved' || !draft.text.trim()) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
      {job?.status === 'failed' && (
        <p className="small" style={{ margin: 0, color: /dry run/i.test(job.error || '') ? 'var(--text-dim)' : 'var(--error)' }}>
          Last attempt ({job.username ? `@${job.username}` : 'agent'}): {job.error}
        </p>
      )}
      {job?.status === 'cancelled' && <p className="small text-dim" style={{ margin: 0 }}>Cancelled before it posted.</p>}

      {!ctx ? (
        <p className="small text-dim" style={{ margin: 0 }}>Loading posting accounts…</p>
      ) : ctx.accounts.length === 0 ? (
        <p className="small text-dim" style={{ margin: 0 }}>
          No Shopify Community accounts yet — add one on the <Link href="/accounts">Accounts</Link> page (Shopify tab).
        </p>
      ) : (
        <div className="row" style={{ gap: '0.4rem', flexWrap: 'wrap' }}>
          <select value={chosen} onChange={(e) => setAccountId(e.target.value)} style={{ maxWidth: 260 }} aria-label="Post from">
            {ctx.accounts.map((a) => (
              <option key={a.accountId} value={a.accountId} disabled={!!a.refusal}>
                {a.label} (@{a.username}){a.refusal ? ` — ${a.refusal}` : ''}
              </option>
            ))}
          </select>
          <button
            className={`btn btn-sm ${ctx.dryRun ? 'btn-secondary' : 'btn-primary'}`}
            onClick={() => chosen && void posting.onQueue(draft.draftId, chosen)}
            disabled={busy || !chosen || !!ctx.agentRefusal}
            title={ctx.agentRefusal ?? undefined}
          >
            <Send size={12} /> {busy ? 'Queueing…' : job?.status === 'failed' ? (ctx.dryRun ? 'Rehearse again' : 'Post again') : ctx.dryRun ? 'Rehearse post (dry run)' : 'Post'}
          </button>
          <span className="small text-dim">
            {ctx.dryRun ? 'Shopify is in dry run — the agent types it and does not submit.' : 'Live — the agent will submit this reply.'}
          </span>
        </div>
      )}
      {ctx?.agentRefusal && <p className="small" style={{ margin: 0, color: 'var(--warning)' }}>{ctx.agentRefusal}</p>}
    </div>
  );
}

/**
 * One written reply: the text first, the actions beside it, the reasoning
 * folded away underneath.
 *
 * ⚠️ A FORBIDDEN PHRASE IS THE FIRST THING SHOWN, and the draft is shown WITH
 * it rather than discarded. An EMPTY draft is a decision, not a failure:
 * growth and brand are told to write nothing rather than force a mention, so
 * `angle` carries the reason.
 */
export default function DraftPanel({
  draft,
  fresh,
  sourceTitle,
  onDecide,
  posting,
}: {
  draft: Draft;
  /** Just arrived — marked, so the eye lands on it. */
  fresh: boolean;
  sourceTitle: (id: string) => string;
  onDecide: (draftId: string, status: 'approved' | 'rejected') => void | Promise<void>;
  posting: PostingProps;
}) {
  const empty = draft.text.trim().length === 0;
  return (
    <div
      style={{
        marginTop: '0.4rem',
        padding: '0.9rem 1rem',
        border: `1px solid ${fresh ? 'var(--primary)' : 'var(--border)'}`,
        borderRadius: 'var(--radius-md)',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.6rem',
      }}
    >
      <div className="row" style={{ justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
        <div className="row" style={{ gap: '0.4rem', flexWrap: 'wrap' }}>
          <span className="badge">{MODE_LABEL[draft.mode]}</span>
          {fresh && <span className="badge badge-success">new</span>}
          {!empty && <span className="small text-dim">{draft.words} words</span>}
          {draft.status !== 'pending' && draft.status !== 'posted' && <span className="badge">{draft.status}</span>}
        </div>
        {draft.status === 'pending' && !empty && (
          <div className="row" style={{ gap: '0.4rem' }}>
            <button className="btn btn-secondary btn-sm" onClick={() => void navigator.clipboard?.writeText(draft.text)}>
              Copy
            </button>
            <button className="btn btn-secondary btn-sm" onClick={() => void onDecide(draft.draftId, 'approved')}>
              Approve
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => void onDecide(draft.draftId, 'rejected')}>
              Reject
            </button>
          </div>
        )}
      </div>

      {draft.forbiddenHits.length > 0 && (
        <div className="alert alert-error" style={{ margin: 0 }}>
          <AlertTriangle size={15} aria-hidden /> Contains {draft.forbiddenHits.length} forbidden phrase
          {draft.forbiddenHits.length === 1 ? '' : 's'}: <strong>{draft.forbiddenHits.join(', ')}</strong>. Edit before
          using it.
        </div>
      )}

      {empty ? (
        <p className="text-dim" style={{ margin: 0 }}>
          <em>Nothing written, on purpose.</em> {draft.angle}
        </p>
      ) : (
        <p style={{ whiteSpace: 'pre-wrap', margin: 0, lineHeight: 1.55 }}>{draft.text}</p>
      )}

      {!empty && <PostControls draft={draft} posting={posting} />}

      {!empty && (draft.angle || draft.betterBecause || draft.usedSourceIds.length > 0) && (
        <details>
          <summary className="small text-dim" style={{ cursor: 'pointer' }}>
            Why this draft
          </summary>
          <div className="small" style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', marginTop: '0.35rem', paddingLeft: '0.9rem' }}>
            {draft.angle && (
              <p style={{ margin: 0 }}>
                <span className="text-dim">The angle:</span> {draft.angle}
              </p>
            )}
            {/* The model's own answer to "is this better than what is
                there?". Not a measurement — shown so a reviewer can disagree. */}
            {draft.betterBecause && (
              <p style={{ margin: 0 }}>
                <span className="text-dim">Why it beats what is there:</span> {draft.betterBecause}
              </p>
            )}
            {draft.usedSourceIds.length > 0 && (
              <p style={{ margin: 0 }}>
                <span className="text-dim">Drew on:</span> {draft.usedSourceIds.map(sourceTitle).join('; ')}
              </p>
            )}
          </div>
        </details>
      )}

      {(draft.model || draft.usage) && (
        <div className="small text-faint">
          {draft.model}
          {draft.usage ? ` · ${tokens(draft.usage)}` : ''}
        </div>
      )}
    </div>
  );
}
