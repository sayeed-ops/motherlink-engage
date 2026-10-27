'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { apiGet, apiPost, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/context/AuthContext';
import { instantOf, localDate } from '@/modules/reddit/autopilot';

// The account's warm-up autopilot: on/off, its stage, its time zone, and today's
// planned sessions with how each is going. The numbers behind the plan (stages,
// sessions per day, waking hours) are team-wide, on Settings → Autopilot.

interface Session {
  atMs: number;
  kind: string;
  jobId: string;
  estimatedSec?: number;
  rerolled?: boolean;
  error?: string;
}

interface CommentSlot {
  atMs: number;
  status: string;
  detail?: string;
}

const COMMENT_LABEL: Record<string, string> = {
  planned: 'planned',
  running: 'looking for a thread…',
  queued: 'written — posting',
  nothing: 'nothing worth a comment',
  refused: 'not posted',
  error: 'failed',
  cancelled: 'cancelled',
  missed: 'missed',
};

interface View {
  enabled: boolean;
  timezone: string;
  ownTimezone: string;
  day: number;
  stage: string;
  paused: string;
  lastPlan: { date: string; timezone: string; stage: string; skipped: boolean; sessions: Session[]; comments?: CommentSlot[] } | null;
  jobStatus: Record<string, { status: string; error: string }>;
  wakeStart: string;
  wakeEnd: string;
}

const STATUS_LABEL: Record<string, string> = {
  queued: 'planned',
  posting: 'running',
  completed: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
};

export default function AutopilotPanel({ accountId, canManage }: { accountId: string; canManage: boolean }) {
  const { profile } = useAuth();
  const isAdmin = profile?.role === 'owner' || profile?.role === 'admin';
  const [view, setView] = useState<View | null>(null);
  const [tz, setTz] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // The clock for the "next plan in …" countdown — advanced by the timer only.
  const [now, setNow] = useState(0);

  const load = useCallback(async () => {
    try {
      setView(await apiGet<View>(`/api/accounts/${accountId}/autopilot`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the autopilot.');
    }
  }, [accountId]);

  // Loads from timers only — never synchronously in the effect body.
  useEffect(() => {
    const first = setTimeout(() => {
      setNow(Date.now());
      void load();
    }, 0);
    const t = setInterval(() => {
      setNow(Date.now());
      void load();
    }, 30_000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [load]);

  async function send(body: Record<string, unknown>, done?: string) {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const r = await apiPost<{ result: { outcome: string; detail: string } | null }>(`/api/accounts/${accountId}/autopilot`, body);
      if (r.result) setNote(r.result.detail || r.result.outcome);
      else if (done) setNote(done);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  }

  if (!view) return <p className="text-dim small">{error ?? 'Loading…'}</p>;

  const accountTz = view.lastPlan?.timezone || view.timezone;
  const dayOf = (ms: number, tz?: string) => new Date(ms).toLocaleDateString('en-CA', { timeZone: tz });
  /** "10:23 (17:23 GMT+3)" — the account's own time, then this computer's,
   *  with "next day"/"prev day" when the two fall on different dates. */
  const fmt = (ms: number) => {
    const theirs = new Date(ms).toLocaleTimeString('en-GB', { timeZone: accountTz, hour: '2-digit', minute: '2-digit' });
    const mine = new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZoneName: 'shortOffset' });
    const a = dayOf(ms, accountTz);
    const b = dayOf(ms);
    const shift = b > a ? ', next day' : b < a ? ', prev day' : '';
    return `${theirs} (${mine}${shift})`;
  };
  const plan = view.lastPlan;

  // When the next day is planned: an hour before the waking hours, in the
  // account's time zone (the same rule as dayNeedsPlan on the server). Today's
  // if today is not planned yet and that moment is still ahead, else tomorrow's.
  const minutesOf = (hhmm: string) => {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
  };
  const nextPlan = (() => {
    if (!view.enabled || !now) return null;
    const today = localDate(accountTz, now);
    const planAt = (date: string) => instantOf(accountTz, date, Math.max(0, minutesOf(view.wakeStart) - 60));
    const endToday = instantOf(accountTz, today, minutesOf(view.wakeEnd));
    if (plan?.date !== today) {
      const at = planAt(today);
      if (now < at) return { atMs: at, due: false };
      if (now < endToday) return { atMs: now, due: true };
    }
    const tomorrow = localDate(accountTz, instantOf(accountTz, today, 12 * 60) + 86_400_000);
    return { atMs: planAt(tomorrow), due: false };
  })();
  const inWords = (ms: number) => {
    const mins = Math.max(1, Math.round(ms / 60_000));
    const h = Math.floor(mins / 60);
    return h ? `${h} h ${mins % 60} min` : `${mins} min`;
  };
  // Sessions and comments in one list, in time order.
  type Row = { atMs: number; session?: Session; comment?: CommentSlot };
  const rows: Row[] = plan
    ? [...plan.sessions.map((s) => ({ atMs: s.atMs, session: s })), ...(plan.comments ?? []).map((c) => ({ atMs: c.atMs, comment: c }))].sort(
        (x, y) => x.atMs - y.atMs,
      )
    : [];

  return (
    <div className="stack" style={{ gap: 16 }}>
      <section className="card">
        <div className="card-head">
          <div>
            <h3>Autopilot</h3>
            <p className="text-dim small" style={{ margin: '4px 0 0' }}>
              Plans this account&apos;s warm-up every day by itself — browsing, and joining the communities tagged
              Follow — at irregular times in its own waking hours, with the odd day off. The stages and numbers are on{' '}
              <Link href="/settings/autopilot">Settings → Autopilot</Link>.
            </p>
          </div>
          {canManage && (
            <label className="row small" style={{ gap: 8, cursor: 'pointer' }}>
              <input type="checkbox" checked={view.enabled} disabled={busy} onChange={(e) => send({ enabled: e.target.checked })} />
              <strong>{view.enabled ? 'On' : 'Off'}</strong>
            </label>
          )}
        </div>

        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          <span className="badge badge-no-dot">{view.day ? `day ${view.day} of warm-up` : 'warm-up not started'}</span>
          <span className="badge badge-no-dot">stage: {view.stage}</span>
          <span className="badge badge-no-dot">time zone: {view.timezone}</span>
        </div>

        {view.enabled && view.paused && <p className="text-warning small">Paused: {view.paused}</p>}
        {nextPlan && !view.paused && (
          <p className="text-dim small" style={{ margin: '6px 0 0' }}>
            {nextPlan.due
              ? 'Today’s plan is due now — the next check (within 5 minutes) makes it.'
              : `${plan?.date === localDate(accountTz, now) ? 'Tomorrow’s' : 'Next'} plan in ${inWords(nextPlan.atMs - now)} — at ${fmt(nextPlan.atMs)}.`}
          </p>
        )}
        {note && <p className="text-dim small">{note}</p>}
        {error && <p className="text-error small">{error}</p>}

        {canManage && (
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
            <label className="field" style={{ margin: 0 }}>
              <span>Time zone (the proxy&apos;s)</span>
              <input
                value={tz ?? view.ownTimezone}
                onChange={(e) => setTz(e.target.value)}
                placeholder={`default: ${view.timezone}`}
                style={{ width: 220 }}
              />
            </label>
            {tz !== null && tz !== view.ownTimezone && (
              <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => send({ timezone: tz.trim() }, 'Time zone saved.').then(() => setTz(null))}>
                Save time zone
              </button>
            )}
            {view.enabled && (
              <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => send({ replan: true })} title="Cancel today's sessions that have not started and plan the rest of today again">
                Re-plan today
              </button>
            )}
          </div>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h3>{plan ? `Plan for ${plan.date}` : 'No plan yet'}</h3>
          {plan && <span className="badge badge-no-dot">{plan.stage}</span>}
        </div>
        {!plan && (
          <p className="text-dim small">
            {view.enabled
              ? 'The day is planned an hour before the waking hours start.'
              : 'Switch the autopilot on and it plans the rest of today straight away.'}
          </p>
        )}
        {plan?.skipped && <p className="text-dim small">A day off — no warm-up today, like a person who did not open Reddit.</p>}
        {plan && !plan.skipped && plan.sessions.length === 0 && (
          <p className="text-dim small">Nothing left of today&apos;s waking hours to plan in. Tomorrow is planned in the morning.</p>
        )}
        {plan && (plan.sessions.length > 0 || (plan.comments?.length ?? 0) > 0) && (
          <table className="table small">
            <thead>
              <tr>
                <th>Time ({plan.timezone} · yours)</th>
                <th>Session</th>
                <th>Length</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ atMs, session: s, comment: c }) => {
                if (c) {
                  return (
                    <tr key={`c-${atMs}`}>
                      <td>{fmt(atMs)}</td>
                      <td>Comment</td>
                      <td>—</td>
                      <td className={c.status === 'error' || c.status === 'refused' ? 'text-error' : undefined}>
                        {COMMENT_LABEL[c.status] ?? c.status}
                        {c.detail ? ` — ${c.detail}` : ''}
                      </td>
                    </tr>
                  );
                }
                if (!s) return null;
                const st = s.jobId ? view.jobStatus[s.jobId] : null;
                return (
                  <tr key={`${atMs}-${s.jobId}`}>
                    <td>{fmt(atMs)}</td>
                    <td>{s.kind === 'follow' ? 'Browse + join' : 'Browse'}</td>
                    <td title={s.rerolled ? 'Re-rolled for a longer session after a run of short ones' : undefined}>
                      {s.estimatedSec ? `~${Math.max(1, Math.round(s.estimatedSec / 60))} min` : '—'}
                      {s.rerolled ? ' · longer' : ''}
                    </td>
                    <td className={st?.status === 'failed' || s.error ? 'text-error' : undefined}>
                      {s.error ? `not queued — ${s.error}` : st ? STATUS_LABEL[st.status] ?? st.status : '—'}
                      {st?.error && st.status !== 'completed' ? ` — ${st.error}` : ''}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {isAdmin && (
          <p className="text-faint small" style={{ marginTop: 8 }}>
            On the live site the day is planned automatically every few minutes&apos; check. On a local dev server,
            use Settings → Autopilot → Plan now.
          </p>
        )}
      </section>
    </div>
  );
}
