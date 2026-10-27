'use client';

import type { AccountPostContext } from '@/server/accountPosts';

// A project reply in context: the original post (our saved copy), the analysis
// it was written from, and the comment posted. Shown in Account activity when a
// project reply's row is opened. Read here, act from the account's own browser.

export default function PostReader({ loading, context }: { loading: boolean; context: AccountPostContext | null }) {
  if (loading) return <div className="bordered small text-dim">Loading…</div>;
  if (!context) return <div className="bordered small text-dim">Couldn’t load this reply’s context.</div>;
  const { post, analysis, comment } = context;
  return (
    <div className="bordered stack" style={{ gap: 14 }}>
      {/* The original post — our saved copy */}
      <div>
        <div className="small text-muted" style={{ marginBottom: 4 }}>Original post · r/{context.subreddit || '—'}</div>
        {post ? (
          <>
            <strong className="small">{post.title || '(no title)'}</strong>
            <div className="text-faint small" style={{ margin: '2px 0 6px' }}>
              by u/{post.author || '—'} · {post.score} pts · {post.numComments} comments
            </div>
            {post.body && (
              <div className="small text-dim" style={{ whiteSpace: 'pre-wrap', maxHeight: 200, overflow: 'auto' }}>
                {post.body}
              </div>
            )}
          </>
        ) : (
          <div className="small text-faint">Post copy no longer stored.</div>
        )}
      </div>

      {/* Our analysis */}
      {analysis && (
        <div>
          <div className="small text-muted" style={{ marginBottom: 4 }}>Analysis</div>
          <div className="row" style={{ flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
            {analysis.decision && <span className="badge badge-no-dot">decision: {analysis.decision}</span>}
            <span className="badge badge-no-dot">fit {analysis.score}</span>
            {analysis.growthScore !== null && <span className="badge badge-no-dot">growth {analysis.growthScore}</span>}
            {analysis.riskLevel && <span className="badge badge-no-dot">risk: {analysis.riskLevel}</span>}
          </div>
          {(analysis.suggestedAngle || analysis.growthAngle) && (
            <div className="small text-dim" style={{ marginBottom: 4 }}>
              <em>Angle:</em> {analysis.suggestedAngle || analysis.growthAngle}
            </div>
          )}
          {analysis.reason && <div className="small text-dim" style={{ whiteSpace: 'pre-wrap' }}>{analysis.reason}</div>}
        </div>
      )}

      {/* The comment we posted */}
      <div>
        <div className="small text-muted" style={{ marginBottom: 4 }}>Comment posted</div>
        {comment && comment.body ? (
          <div className="small" style={{ whiteSpace: 'pre-wrap', padding: 10, borderRadius: 8, background: 'var(--bg-subtle, rgba(127,127,127,0.06))' }}>
            {comment.body}
          </div>
        ) : (
          <div className="small text-faint">Comment body not stored.</div>
        )}
        {comment?.permalink && (
          <div className="text-faint small" style={{ marginTop: 6, wordBreak: 'break-all' }}>
            permalink (act on it from the account’s own browser, not here): {comment.permalink}
          </div>
        )}
      </div>
    </div>
  );
}

