'use client';

import { useEffect, useState } from 'react';
import { apiPost, ApiError } from '@/lib/api';
import { subscribeDoc, agentStatusPath, agentControlPath } from '@/lib/data';
import { readAgentStatus } from '@/lib/agentStatus';
import { useAuth } from '@/lib/context/AuthContext';

// The posting agent's status + the dry-run switch, shown on the Accounts page.
// One agent, one queue, so this is global platform state.
//
// Online/offline is a pure heartbeat: the agent stamps agents/agent every ~5s —
// including on a timer WHILE a job runs, which is the whole reason a multi-minute
// post no longer reads as "offline". We call it online only if that stamp is
// < 20s old. Starting/stopping the agent PROCESS is done from the local control
// panel on the host (see apps/poster-agent) — nothing here can launch it. What
// this offers is the one remote control that matters: dry run (types the reply
// but never submits), which the running agent re-reads every poll.
//
// The queue/activity wording lives in lib/agentStatus.ts, shared with the sidebar.

export default function AgentControls() {
  const { profile } = useAuth();
  const canManage =
    profile?.role === 'owner' ||
    profile?.role === 'admin' ||
    !!profile?.globalPermissions?.includes('accounts.manage');
  // The cloud server's own controls — Wake now / Keep awake and the idle time —
  // cost money, so only the owner sees them. Everyone else sees the status and,
  // with accounts.manage, the dry-run switch. The routes enforce the same.
  const isOwner = profile?.role === 'owner';

  const [agent, setAgent] = useState<Record<string, unknown> | null>(null);
  const [control, setControl] = useState<Record<string, unknown> | null>(null);
  const [now, setNow] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [waking, setWaking] = useState(false);
  const [idleDraft, setIdleDraft] = useState<string | null>(null);

  useEffect(() => {
    // Advance `now` only from callbacks (the tick, or a snapshot), never from the
    // effect body — see the same note in SidebarAgentControl. Until the first
    // snapshot arrives it's 0, which readAgentStatus treats as offline.
    const t = setInterval(() => setNow(Date.now()), 5000);
    const unsubAgent = subscribeDoc<Record<string, unknown>>(agentStatusPath, (d) => {
      setAgent(d);
      setNow(Date.now());
    });
    const unsubControl = subscribeDoc<Record<string, unknown>>(agentControlPath, setControl);
    return () => {
      clearInterval(t);
      unsubAgent();
      unsubControl();
    };
  }, []);

  const status = readAgentStatus(agent, now);
  const online = status.online;

  const dryRun =
    typeof control?.dryRun === 'boolean'
      ? (control.dryRun as boolean)
      : typeof agent?.dryRun === 'boolean'
        ? (agent.dryRun as boolean)
        : true; // safest default: assume dry-run until we know otherwise

  // Minutes the cloud server waits with nothing to do before it shuts down.
  // Absent on the control doc means the agent's default, 5.
  const idleMinutes = typeof control?.idleSleepMinutes === 'number' ? (control.idleSleepMinutes as number) : 5;
  // Wake now / Keep awake hold the server up until this time, whatever the idle
  // setting, so it is still on when someone connects.
  const awakeUntilMs = typeof control?.awakeUntilMs === 'number' ? (control.awakeUntilMs as number) : 0;
  const keptAwake = now > 0 && awakeUntilMs > now;

  async function wakeNow() {
    setWaking(true);
    setError(null);
    try {
      const r = await apiPost<{ outcome: string }>('/api/agent/wake', {});
      if (r.outcome === 'not-configured') setError('Waking is not set up on this deployment.');
      else if (r.outcome === 'stopping') setError('The server is still shutting down — it starts again by itself within 5 minutes.');
      else if (r.outcome === 'error') setError('Could not start the server. Check the AWS key in the deployment settings.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not wake the server.');
    } finally {
      setWaking(false);
    }
  }

  async function saveIdleMinutes() {
    if (idleDraft == null) return;
    const minutes = Number(idleDraft);
    setBusy(true);
    setError(null);
    try {
      await apiPost('/api/agent/idle-sleep', { minutes });
      setIdleDraft(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the idle time.');
    } finally {
      setBusy(false);
    }
  }

  async function toggleDryRun() {
    setBusy(true);
    setError(null);
    try {
      await apiPost('/api/agent/dry-run', { dryRun: !dryRun });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not change dry-run mode.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="agent-chip row between" style={{ flexWrap: 'wrap', gap: 10 }}>
        <span className="row" style={{ gap: 8 }}>
          <span className={`dot ${online ? 'on' : status.waking ? 'waking' : status.asleep ? 'sleep' : 'off'}`} />
          {online ? (
            <span className="small">
              <strong>{status.busy ? 'Posting agent working' : 'Posting agent online'}</strong>
              <span className="text-dim" title={status.current ? `job ${status.current.jobId}` : undefined}>
                {' '}
                · {status.activity} · {String(agent?.postedSession ?? 0)} posted this session
              </span>
            </span>
          ) : status.waking || status.asleep ? (
            <span className="small">
              <strong>{status.waking ? 'Posting agent waking up' : 'Posting agent asleep'}</strong>
              <span className="text-dim">
                {' '}
                · {status.waking ? `the server is starting — about 3–5 minutes${status.queued > 0 ? ` · ${status.queued} waiting` : ''}` : 'the server is off to save money, and starts when a task is queued'}
              </span>
            </span>
          ) : (
            <span className="small">
              <strong className="text-error">Posting agent offline</strong>
              <span className="text-dim"> · start it on the host (open the Motherlink Agent app)</span>
            </span>
          )}
        </span>

        <span className="row small" style={{ gap: 8 }}>
          <span className={dryRun ? 'badge badge-warning' : 'badge badge-success'}>
            {dryRun ? 'Dry run — not posting' : 'Live — posting for real'}
          </span>
          {isOwner && (
            <button
              className="btn btn-secondary btn-sm"
              onClick={wakeNow}
              disabled={waking}
              title={
                online
                  ? 'Keep the cloud server on for the next 30 minutes — time to connect to it'
                  : 'Start the cloud server now and keep it on for 30 minutes'
              }
            >
              {waking ? 'Waking…' : online || status.waking ? 'Keep awake 30 min' : 'Wake now'}
            </button>
          )}
          {canManage && (
            <button
              className="btn btn-secondary btn-sm"
              onClick={toggleDryRun}
              disabled={busy}
              title={
                dryRun
                  ? 'Turn off dry run so approved replies post for real'
                  : 'Turn on dry run so the agent types but never submits'
              }
            >
              {busy ? 'Saving…' : dryRun ? 'Turn off dry run' : 'Turn on dry run'}
            </button>
          )}
        </span>
      </div>

      {isOwner && (
        <label className="row small text-dim" style={{ gap: 6 }}>
          Cloud server sleeps after
          <input
            type="number"
            min={0}
            max={240}
            step={1}
            style={{ width: 64, padding: '2px 6px' }}
            value={idleDraft ?? String(idleMinutes)}
            onChange={(e) => setIdleDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void saveIdleMinutes()}
            aria-label="Minutes with nothing to do before the cloud server sleeps"
          />
          min with nothing to do (0 = never)
          {keptAwake && (
            <span>
              {' '}· kept awake until{' '}
              {new Date(awakeUntilMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
          {idleDraft != null && idleDraft !== String(idleMinutes) && (
            <button className="btn btn-secondary btn-sm" onClick={saveIdleMinutes} disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          )}
        </label>
      )}
      {error && <p className="text-error small" style={{ margin: 0 }}>{error}</p>}
      {/* Says out loud what the old frozen "1 queued" never did: a humanized post
          is slow ON PURPOSE, so minutes of apparent silence are the normal case. */}
      {status.busy && (
        <p className="text-dim small" style={{ margin: 0 }}>
          {status.running.length > 1 ? `${status.running.length} jobs running at once` : 'Working on a job now'} — the
          approach plan (browse, read, skim, type) takes several minutes by design. Nothing is stuck.
        </p>
      )}
      {/* One line per running job once there can be several — a single chip
          cannot say that a reply and a warm-up are both in flight. */}
      {status.running.length > 1 && (
        <ul className="small text-dim" style={{ margin: 0, paddingLeft: '1.1rem' }}>
          {status.running.map((j) => (
            <li key={j.jobId} title={`job ${j.jobId}`}>
              {j.expectedUsername ? `u/${j.expectedUsername}` : 'account'} · {j.kind || 'job'}
              {j.subreddit ? ` · r/${j.subreddit}` : ''} · {j.stage}
            </li>
          ))}
        </ul>
      )}
      {online && !status.busy && !dryRun && (
        <p className="text-dim small" style={{ margin: 0 }}>
          Live and running — approved replies will post for real.
        </p>
      )}
    </div>
  );
}
