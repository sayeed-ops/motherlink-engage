'use client';

import { AlertTriangle } from 'lucide-react';
import { MODE_LABEL } from '@/modules/shopify/modes';
import { tokens, type Draft } from './types';

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
}: {
  draft: Draft;
  /** Just arrived — marked, so the eye lands on it. */
  fresh: boolean;
  sourceTitle: (id: string) => string;
  onDecide: (draftId: string, status: 'approved' | 'rejected') => void | Promise<void>;
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
          {draft.status !== 'pending' && <span className="badge">{draft.status}</span>}
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
