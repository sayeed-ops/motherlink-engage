'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiGet, ApiError } from '@/lib/api';
import ApproachPlanView from '@/components/ApproachPlanView';
import WarmupLoopView from '@/components/WarmupLoopView';
import PostReader from '@/components/PostReader';
import type { AccountPostContext } from '@/server/accountPosts';
import type { ActivityRow, ActivityType, ActivityStatus } from '@/server/activityFeed';
import type { WarmupLoopPlan, WarmupTrace } from '@/modules/reddit/warmupWalk';

// Everything the tool did with the accounts, in one filterable list — the only
// history view (server/activityFeed.ts). Used on Accounts → Activity (all
// accounts) and on each account's Dashboard (one account, `accountId` given).

const TYPE_LABEL: Record<ActivityType, string> = {
  browse: 'Browse',
  follow: 'Browse + join',
  'warmup-comment': 'Warm-up comment',
  'project-comment': 'Project comment',
  'shopify-reply': 'Shopify reply',
};
const STATUS_LABEL: Record<ActivityStatus, string> = {
  planned: 'planned',
  queued: 'queued',
  running: 'running',
  done: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
  nothing: 'nothing found',
  rejected: 'rejected',
};
const STATUS_BADGE: Record<ActivityStatus, string> = {
  planned: 'badge',
  queued: 'badge-warning',
  running: 'badge-warning',
  done: 'badge-success',
  failed: 'badge-error',
  cancelled: 'badge',
  nothing: 'badge',
  rejected: 'badge',
};
type Range = 'today' | 'yesterday' | '7' | '30' | 'all';
const RANGE_LABEL: Record<Range, string> = { today: 'Today', yesterday: 'Yesterday', '7': 'Last 7 days', '30': 'Last 30 days', all: 'Everything loaded' };

interface Feed {
  rows: ActivityRow[];
  oldestMs: number;
  truncated: boolean;
}

const startOfDay = (ms: number) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
const when = (ms: number) =>
  ms
    ? new Date(ms).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZoneName: 'shortOffset' })
    : '—';
const dur = (a: number, b: number) => {
  if (!a || !b || b < a) return '';
  const s = Math.round((b - a) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};

function Detail({ row }: { row: ActivityRow }) {
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A posted project reply: the original post and the analysis behind it.
  const isReply = row.type === 'project-comment' && row.key.startsWith('job:');
  const [context, setContext] = useState<AccountPostContext | null>(null);
  const [contextLoading, setContextLoading] = useState(isReply);
  useEffect(() => {
    apiGet<Record<string, unknown>>(`/api/activity/detail?key=${encodeURIComponent(row.key)}`)
      .then(setDetail)
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Could not load the details.'));
    if (isReply) {
      apiGet<AccountPostContext>(`/api/accounts/${row.accountId}/posts/${row.key.slice(4)}`)
        .then(setContext)
        .catch(() => setContext(null))
        .finally(() => setContextLoading(false));
    }
  }, [row.key, row.accountId, isReply]);

  return (
    <div className="stack" style={{ gap: 10, marginTop: 8 }}>
      {row.threadTitle && (
        <p className="small" style={{ margin: 0 }}>
          <span className="text-faint">Thread: </span>
          {row.threadUrl ? (
            <a href={row.threadUrl} target="_blank" rel="noopener noreferrer">
              {row.threadTitle}
            </a>
          ) : (
            row.threadTitle
          )}
        </p>
      )}
      {isReply ? (
        <PostReader loading={contextLoading} context={context} />
      ) : (
        row.text && (
          <div className="bordered small" style={{ whiteSpace: 'pre-wrap' }}>
            {row.text}
          </div>
        )
      )}
      {row.reason && <p className={`small ${row.status === 'failed' ? 'text-error' : 'text-dim'}`} style={{ margin: 0 }}>{row.reason}</p>}
      {error && <p className="text-error small">{error}</p>}
      {!detail && !error && <p className="text-dim small">Loading the steps…</p>}
      {detail?.kind === 'warmup' && (
        <WarmupLoopView plan={detail.plan as WarmupLoopPlan} trace={detail.trace as WarmupTrace} day={(detail.day as number) ?? undefined} compact />
      )}
      {detail?.kind === 'approach' && (
        <ApproachPlanView
          plan={detail.approachPlan as never}
          trace={detail.approachTrace as never}
          browse={detail.browse as never}
          firstVisit={detail.firstVisit as never}
          compact
        />
      )}
      {detail?.kind === 'scan' && (
        <div className="small stack" style={{ gap: 6 }}>
          {(detail.gap as { angle?: string; posterWant?: string } | null)?.angle && (
            <p className="text-dim" style={{ margin: 0 }}>
              Wanted: {(detail.gap as { posterWant?: string }).posterWant} · angle: {(detail.gap as { angle?: string }).angle}
            </p>
          )}
          {!!detail.criticReason && <p className="text-dim" style={{ margin: 0 }}>Reviewer: {String(detail.criticReason)}</p>}
          {(detail.rejected as { text: string; failures: { code: string }[] }[] | undefined)?.map((r, i) => (
            <p key={i} className="text-faint" style={{ margin: 0, textDecoration: 'line-through' }}>
              {r.failures.map((f) => f.code).join(', ')}: {r.text}
            </p>
          ))}
          {(detail.trace as string[] | undefined)?.length ? (
            <pre className="small text-faint" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
              {(detail.trace as string[]).join('\n')}
            </pre>
          ) : null}
        </div>
      )}
    </div>
  );
}

export default function ActivityList({ accountId }: { accountId?: string }) {
  const [feed, setFeed] = useState<Feed | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(0);
  const [open, setOpen] = useState<string | null>(null);

  const [account, setAccount] = useState('');
  const [types, setTypes] = useState<ActivityType[]>([]);
  const [origin, setOrigin] = useState('');
  const [status, setStatus] = useState('');
  const [project, setProject] = useState('');
  const [range, setRange] = useState<Range>('30');
  const [upcoming, setUpcoming] = useState(false);

  const base = `/api/activity?days=30${accountId ? `&accountId=${encodeURIComponent(accountId)}` : ''}`;
  const load = useCallback(async () => {
    try {
      setFeed(await apiGet<Feed>(base));
      setNow(Date.now());
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load the activity.');
    }
  }, [base]);
  useEffect(() => {
    const first = setTimeout(load, 0);
    return () => clearTimeout(first);
  }, [load]);

  async function loadOlder() {
    if (!feed) return;
    setLoadingOlder(true);
    try {
      const older = await apiGet<Feed>(`${base}&before=${feed.oldestMs}`);
      const seen = new Set(feed.rows.map((r) => r.key));
      setFeed({ rows: [...feed.rows, ...older.rows.filter((r) => !seen.has(r.key))], oldestMs: older.oldestMs, truncated: older.truncated });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load older activity.');
    } finally {
      setLoadingOlder(false);
    }
  }

  const rows = useMemo(() => feed?.rows ?? [], [feed]);
  const accounts = useMemo(() => [...new Map(rows.map((r) => [r.accountId, r.accountLabel])).entries()].sort((a, b) => a[1].localeCompare(b[1])), [rows]);
  const projects = useMemo(() => [...new Map(rows.filter((r) => r.projectId).map((r) => [r.projectId, r.projectName])).entries()], [rows]);

  const shown = useMemo(() => {
    const today = now ? startOfDay(now) : 0;
    const from = range === 'today' ? today : range === 'yesterday' ? today - 86_400_000 : range === '7' ? now - 7 * 86_400_000 : range === '30' ? now - 30 * 86_400_000 : 0;
    const to = range === 'yesterday' ? today : Infinity;
    return rows.filter(
      (r) =>
        (upcoming || r.status !== 'planned') &&
        (!account || r.accountId === account) &&
        (!types.length || types.includes(r.type)) &&
        (!origin || r.origin === origin) &&
        (!status || r.status === status) &&
        (!project || r.projectId === project) &&
        (r.status === 'planned' || (r.atMs >= from && r.atMs < to)),
    );
  }, [rows, now, range, upcoming, account, types, origin, status, project]);

  const summary = useMemo(() => {
    const by = (f: (r: ActivityRow) => boolean) => shown.filter(f).length;
    return {
      total: shown.length,
      done: by((r) => r.status === 'done'),
      failed: by((r) => r.status === 'failed'),
      cancelled: by((r) => r.status === 'cancelled'),
      warmupComments: by((r) => r.type === 'warmup-comment' && r.status === 'done'),
      projectComments: by((r) => (r.type === 'project-comment' || r.type === 'shopify-reply') && r.status === 'done'),
      sessions: by((r) => (r.type === 'browse' || r.type === 'follow') && r.status === 'done'),
    };
  }, [shown]);

  const toggleType = (t: ActivityType) => setTypes(types.includes(t) ? types.filter((x) => x !== t) : [...types, t]);

  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {!accountId && (
          <select value={account} onChange={(e) => setAccount(e.target.value)} aria-label="Account">
            <option value="">All accounts</option>
            {accounts.map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        )}
        <select value={range} onChange={(e) => setRange(e.target.value as Range)} aria-label="Dates">
          {(Object.keys(RANGE_LABEL) as Range[]).map((r) => (
            <option key={r} value={r}>
              {RANGE_LABEL[r]}
            </option>
          ))}
        </select>
        <select value={origin} onChange={(e) => setOrigin(e.target.value)} aria-label="Started by">
          <option value="">Started by anyone</option>
          <option value="autopilot">Autopilot</option>
          <option value="manual">By hand</option>
          <option value="project">Project</option>
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="">Any status</option>
          {(Object.keys(STATUS_LABEL) as ActivityStatus[]).map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
        {projects.length > 0 && (
          <select value={project} onChange={(e) => setProject(e.target.value)} aria-label="Project">
            <option value="">All projects</option>
            {projects.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        )}
        <label className="row small" style={{ gap: 6, cursor: 'pointer' }}>
          <input type="checkbox" checked={upcoming} onChange={(e) => setUpcoming(e.target.checked)} /> Show upcoming
        </label>
      </div>
      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        {(Object.keys(TYPE_LABEL) as ActivityType[]).map((t) => (
          <button key={t} type="button" className={`chip-tab ${types.includes(t) ? 'active' : ''}`} onClick={() => toggleType(t)}>
            {TYPE_LABEL[t]}
          </button>
        ))}
        {types.length > 0 && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setTypes([])}>
            All types
          </button>
        )}
      </div>

      <p className="text-faint small" style={{ margin: 0 }}>
        Links open Reddit in your own browser — fine for reading. To vote or reply, use the account&apos;s own AdsPower
        profile, never your browser.
      </p>
      {error && <p className="text-error small">{error}</p>}
      {!feed && !error && <p className="text-dim small">Loading activity…</p>}

      {feed && (
        <>
          <p className="small text-dim" style={{ margin: 0 }}>
            {summary.total} item{summary.total === 1 ? '' : 's'} · {summary.done} done · {summary.failed} failed · {summary.cancelled} cancelled ·{' '}
            {summary.sessions} browsing sessions · {summary.warmupComments} warm-up comments · {summary.projectComments} project comments posted
          </p>
          {shown.length === 0 ? (
            <p className="text-dim small">Nothing matches these filters.</p>
          ) : (
            <table className="table small">
              <thead>
                <tr>
                  <th>When (yours)</th>
                  {!accountId && <th>Account</th>}
                  <th>What</th>
                  <th>Where</th>
                  <th>Status</th>
                  <th>Steps</th>
                  <th>Links</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <ActivityTableRow key={r.key} row={r} showAccount={!accountId} open={open === r.key} onToggle={() => setOpen(open === r.key ? null : r.key)} />
                ))}
              </tbody>
            </table>
          )}
          <div className="row" style={{ gap: 8 }}>
            <button className="btn btn-secondary btn-sm" onClick={loadOlder} disabled={loadingOlder}>
              {loadingOlder ? 'Loading…' : 'Load older'}
            </button>
            <span className="text-faint small">Showing back to {new Date(feed.oldestMs).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}</span>
          </div>
        </>
      )}
    </div>
  );
}

function ActivityTableRow({ row: r, showAccount, open, onToggle }: { row: ActivityRow; showAccount: boolean; open: boolean; onToggle: () => void }) {
  const commentLink = r.permalink && r.permalink !== r.threadUrl ? r.permalink : '';
  return (
    <>
      <tr>
        <td title={r.startedAtMs ? `started ${when(r.startedAtMs)}` : undefined}>
          {when(r.atMs)}
          {r.startedAtMs && r.finishedAtMs ? <span className="text-faint"> · {dur(r.startedAtMs, r.finishedAtMs)}</span> : null}
        </td>
        {showAccount && <td>{r.accountLabel}</td>}
        <td>
          {TYPE_LABEL[r.type]}
          <span className="text-faint"> · {r.origin === 'project' ? r.projectName || 'project' : r.origin === 'autopilot' ? 'autopilot' : 'by hand'}</span>
        </td>
        <td>{r.subreddit ? `r/${r.subreddit}` : '—'}</td>
        <td>
          <span className={`badge badge-no-dot ${STATUS_BADGE[r.status]}`}>{STATUS_LABEL[r.status]}</span>
        </td>
        <td>
          {r.steps ? `${r.steps.ran}/${r.steps.planned}${r.steps.failed ? ` · ${r.steps.failed} failed` : ''}` : '—'}
          {r.upvotes ? <span className="text-faint"> · {r.upvotes}▲</span> : null}
        </td>
        <td>
          {commentLink && (
            <a href={commentLink} target="_blank" rel="noopener noreferrer">
              Comment ↗
            </a>
          )}
          {commentLink && r.threadUrl ? ' · ' : ''}
          {r.threadUrl && (
            <a href={r.threadUrl} target="_blank" rel="noopener noreferrer" title={commentLink ? undefined : 'The agent could not capture the comment’s own link for this one'}>
              Thread ↗
            </a>
          )}
        </td>
        <td>
          <button className="btn btn-ghost btn-sm" onClick={onToggle}>
            {open ? 'Hide' : 'Details'}
          </button>
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={showAccount ? 8 : 7}>
            <Detail row={r} />
          </td>
        </tr>
      )}
    </>
  );
}
