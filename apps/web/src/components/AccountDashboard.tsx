'use client';

import { useState } from 'react';
import { RefreshCw, TrendingUp, BookOpen, X, Award, Users2, CalendarClock, MessageSquare, FileText, Footprints } from 'lucide-react';
import { apiPost, apiGet, ApiError } from '@/lib/api';
import ApproachPlanView from '@/components/ApproachPlanView';
import type { AccountStats, AccountStatSnapshot } from '@/modules/reddit/types';
import type { AccountActivity } from '@/server/accountActivity';
import type { AccountPostContext } from '@/server/accountPosts';

// The account Dashboard — two honest halves:
//
//   Reddit-side truth (captured in-session by the agent): karma, subscriptions,
//   account age. The improvement signal, and the only part that needs the agent.
//
//   Our own activity (from `jobs`): what the tool posted, where, success/fail.
//   Exact and free — we generated it, so we never scrape Reddit for it.
//
// "Registered here" (account.createdAt) is the baseline anchor; deltas are shown
// against the first-ever capture (statsBaseline) so you can see whether karma is
// actually climbing since we took the account on.

const ms = (v: unknown): number =>
  v && typeof v === 'object' && 'toMillis' in v ? (v as { toMillis(): number }).toMillis() : 0;

function relTime(msVal: number): string {
  if (!msVal) return 'never';
  const diff = Date.now() - msVal;
  const m = Math.round(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(msVal).toLocaleDateString();
}

function duration(fromMs: number): string {
  if (!fromMs) return '—';
  const days = Math.floor((Date.now() - fromMs) / 86400000);
  if (days < 1) return 'today';
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  const years = Math.floor(months / 12);
  const rem = months % 12;
  return rem ? `${years}y ${rem}mo` : `${years}y`;
}

function DeltaBadge({ delta }: { delta: number }) {
  if (!Number.isFinite(delta) || delta === 0) return <span className="text-faint small">±0 since baseline</span>;
  const up = delta > 0;
  return (
    <span className={`small ${up ? 'text-success' : 'text-error'}`}>
      {up ? '+' : ''}
      {delta.toLocaleString()} since baseline
    </span>
  );
}

/** Minimal inline-SVG karma sparkline. No chart lib — CSP-safe and it's one line. */
function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const w = 220;
  const h = 40;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * w;
      const y = h - ((v - min) / span) * (h - 4) - 2;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ display: 'block' }} aria-hidden>
      <polyline points={pts} fill="none" stroke="var(--primary)" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function Tile({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="card">
      <div className="row" style={{ gap: 6, color: 'var(--text-muted)', marginBottom: 6 }}>
        {icon}
        <span className="small">{label}</span>
      </div>
      <div className="stat">{value}</div>
      {sub && <div style={{ marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

/** In-app reader: the saved post + analysis + the comment we posted. Renders our
 *  OWN copies so reviewing never opens the live comment on reddit.com. The
 *  permalink is shown as plain, non-clickable text — if you need to act on it, do
 *  so from the account's own AdsPower browser, not this dashboard's browser. */
function PostReader({ loading, context }: { loading: boolean; context: AccountPostContext | null }) {
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

export default function AccountDashboard({
  accountId,
  account,
  snapshots,
  activity,
  activityLoading,
  canManage,
}: {
  accountId: string;
  account: Record<string, unknown>;
  snapshots: AccountStatSnapshot[] | null;
  activity: AccountActivity | null;
  activityLoading: boolean;
  canManage: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justRequested, setJustRequested] = useState(false);
  // In-app comment reader: which job is open, its loaded context, loading flag.
  const [openJobId, setOpenJobId] = useState<string | null>(null);
  // Which job's approach (plan + what actually happened) is expanded.
  const [openPlanJobId, setOpenPlanJobId] = useState<string | null>(null);
  const [context, setContext] = useState<AccountPostContext | null>(null);
  const [contextLoading, setContextLoading] = useState(false);

  async function readPost(jobId: string) {
    if (openJobId === jobId) {
      setOpenJobId(null);
      setContext(null);
      return;
    }
    setOpenJobId(jobId);
    setContext(null);
    setContextLoading(true);
    try {
      const ctx = await apiGet<AccountPostContext>(`/api/accounts/${accountId}/posts/${jobId}`);
      setContext(ctx);
    } catch {
      setContext(null);
    } finally {
      setContextLoading(false);
    }
  }

  const stats = account.stats as AccountStats | undefined;
  const baseline = (account.statsBaseline as AccountStats | undefined) ?? stats;
  const registeredHereMs = ms(account.createdAt);
  const refreshPending = !!account.statsRefreshRequestedAt || justRequested;
  const manualKarma = (account.karma as number) ?? 0;

  // Karma trend from snapshots (they arrive newest-first → chronological for the line).
  const karmaSeries = snapshots ? [...snapshots].reverse().map((s) => s.totalKarma) : [];

  async function requestRefresh() {
    setBusy(true);
    setError(null);
    try {
      await apiPost(`/api/accounts/${accountId}/refresh-stats`, {});
      setJustRequested(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not request a refresh.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sections">
      {/* ---- Reddit-side stats (captured in-session) ---- */}
      <section>
        <div className="card-head" style={{ marginBottom: 12 }}>
          <div>
            <h3 style={{ marginBottom: 2 }}>Reddit-side stats</h3>
            <p className="text-dim small" style={{ marginBottom: 0 }}>
              {stats
                ? `Captured in-session · updated ${relTime(stats.capturedAtMs)}`
                : 'Not captured yet — the agent reads these the next time it opens this profile.'}
            </p>
          </div>
          {canManage && (
            <button className="btn btn-secondary btn-sm" onClick={requestRefresh} disabled={busy}>
              <RefreshCw size={13} /> {busy ? 'Requesting…' : 'Update data'}
            </button>
          )}
        </div>

        {error && <p className="text-error small">{error}</p>}
        {refreshPending && (
          <p className="text-warning small" style={{ marginTop: -4 }}>
            Refresh pending — the account updates its own data next time it’s active in AdsPower (a post or
            warm-up session). No crawler is dispatched, so nothing correlates the accounts.
          </p>
        )}

        {!stats ? (
          <div className="card">
            <p className="text-dim small" style={{ marginBottom: 0 }}>
              Karma, subscriptions and account age appear here after the first posting or warm-up session.
              {manualKarma > 0 && ` (Manual karma on file: ${manualKarma.toLocaleString()}.)`}
            </p>
          </div>
        ) : (
          <>
            <div className="grid-2">
              <Tile
                icon={<Award size={14} />}
                label="Total karma"
                value={stats.totalKarma.toLocaleString()}
                sub={<DeltaBadge delta={stats.totalKarma - (baseline?.totalKarma ?? stats.totalKarma)} />}
              />
              <Tile
                icon={<FileText size={14} />}
                label="Post karma"
                value={stats.linkKarma.toLocaleString()}
                sub={<DeltaBadge delta={stats.linkKarma - (baseline?.linkKarma ?? stats.linkKarma)} />}
              />
              <Tile
                icon={<MessageSquare size={14} />}
                label="Comment karma"
                value={stats.commentKarma.toLocaleString()}
                sub={<DeltaBadge delta={stats.commentKarma - (baseline?.commentKarma ?? stats.commentKarma)} />}
              />
              <Tile
                icon={<CalendarClock size={14} />}
                label="Reddit account age"
                value={duration(stats.redditCreatedAtMs)}
                sub={
                  stats.redditCreatedAtMs ? (
                    <span className="text-faint small">since {new Date(stats.redditCreatedAtMs).toLocaleDateString()}</span>
                  ) : undefined
                }
              />
              <Tile
                icon={<CalendarClock size={14} />}
                label="Registered here"
                value={duration(registeredHereMs)}
                sub={
                  registeredHereMs ? (
                    <span className="text-faint small">baseline {new Date(registeredHereMs).toLocaleDateString()}</span>
                  ) : undefined
                }
              />
            </div>

            {karmaSeries.length >= 2 && (
              <div className="card" style={{ marginTop: 16 }}>
                <div className="row" style={{ gap: 6, color: 'var(--text-muted)', marginBottom: 8 }}>
                  <TrendingUp size={14} />
                  <span className="small">Total karma over {karmaSeries.length} captures</span>
                </div>
                <Sparkline values={karmaSeries} />
              </div>
            )}
          </>
        )}
      </section>

      {/* ---- Our own activity (from jobs) ---- */}
      <section>
        <div className="card-head" style={{ marginBottom: 12 }}>
          <div>
            <h3 style={{ marginBottom: 2 }}>Activity through the tool</h3>
            <p className="text-dim small" style={{ marginBottom: 0 }}>
              What we posted from this account — exact, from our own queue (not scraped).
            </p>
          </div>
        </div>

        {activityLoading && !activity ? (
          <p className="text-dim small">Loading activity…</p>
        ) : activity ? (
          <>
            <div className="grid-2">
              <Tile icon={<FileText size={14} />} label="Posts made" value={activity.posted.toLocaleString()} sub={<span className="text-faint small">of {activity.totalJobs} attempts</span>} />
              <Tile
                icon={<TrendingUp size={14} />}
                label="Success rate"
                value={activity.posted + activity.failed > 0 ? `${Math.round((activity.posted / (activity.posted + activity.failed)) * 100)}%` : '—'}
                sub={<span className="text-faint small">{activity.failed} failed · {activity.pending} pending</span>}
              />
              <Tile icon={<Users2 size={14} />} label="Subreddits posted in" value={activity.bySubreddit.length.toLocaleString()} />
              <Tile
                icon={<CalendarClock size={14} />}
                label="Last post via tool"
                value={activity.lastPostAtMs ? relTime(activity.lastPostAtMs) : '—'}
                sub={activity.firstPostAtMs ? <span className="text-faint small">first {new Date(activity.firstPostAtMs).toLocaleDateString()}</span> : undefined}
              />
            </div>

            {activity.bySubreddit.length > 0 && (
              <div className="card" style={{ marginTop: 16 }}>
                <div className="small text-muted" style={{ marginBottom: 8 }}>By subreddit</div>
                <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
                  {activity.bySubreddit.slice(0, 12).map((s) => (
                    <span key={s.subreddit} className="badge badge-no-dot">
                      r/{s.subreddit} · {s.posted}/{s.total}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {activity.recent.length > 0 && (
              <div className="card" style={{ marginTop: 16 }}>
                <div className="small text-muted" style={{ marginBottom: 8 }}>Recent</div>
                <ul className="list" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {activity.recent.map((p) => (
                    <li key={p.jobId} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <div className="row" style={{ justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                        <span className="small">
                          <span className={`badge badge-no-dot ${p.status === 'posted' ? 'badge-success' : p.status === 'failed' ? 'badge' : 'badge-warning'}`}>{p.status}</span>{' '}
                          r/{p.subreddit || '—'}
                        </span>
                        <span className="row" style={{ gap: 10 }}>
                          <span className="text-faint small">{p.completedAtMs || p.createdAtMs ? new Date(p.completedAtMs || p.createdAtMs).toLocaleDateString() : ''}</span>
                          {(p.approachPlan.length > 0 || p.approachTrace.length > 0) && (
                            <button
                              className="btn btn-ghost btn-sm"
                              onClick={() => setOpenPlanJobId(openPlanJobId === p.jobId ? null : p.jobId)}
                              style={{ padding: '2px 8px' }}
                              title="How this account approached the post before replying"
                            >
                              {openPlanJobId === p.jobId ? <X size={12} /> : <Footprints size={12} />}{' '}
                              {openPlanJobId === p.jobId ? 'Close' : 'Approach'}
                            </button>
                          )}
                          {p.status === 'posted' && (
                            <button className="btn btn-ghost btn-sm" onClick={() => readPost(p.jobId)} style={{ padding: '2px 8px' }}>
                              {openJobId === p.jobId ? <X size={12} /> : <BookOpen size={12} />} {openJobId === p.jobId ? 'Close' : 'Read'}
                            </button>
                          )}
                        </span>
                      </div>
                      {openPlanJobId === p.jobId && (
                        <ApproachPlanView plan={p.approachPlan} trace={p.approachTrace} compact />
                      )}
                      {openJobId === p.jobId && (
                        <PostReader loading={contextLoading} context={context} />
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {activity.totalJobs === 0 && (
              <div className="card">
                <p className="text-dim small" style={{ marginBottom: 0 }}>Nothing posted through this account yet.</p>
              </div>
            )}
          </>
        ) : (
          <p className="text-dim small">Activity unavailable.</p>
        )}
      </section>
    </div>
  );
}
