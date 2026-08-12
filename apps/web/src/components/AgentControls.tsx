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

  const [agent, setAgent] = useState<Record<string, unknown> | null>(null);
  const [control, setControl] = useState<Record<string, unknown> | null>(null);
  const [now, setNow] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
          <span className={`dot ${online ? 'on' : 'off'}`} />
          {online ? (
            <span className="small">
              <strong>{status.busy ? 'Posting agent working' : 'Posting agent online'}</strong>
              <span className="text-dim" title={status.current ? `job ${status.current.jobId}` : undefined}>
                {' '}
                · {status.activity} · {String(agent?.postedSession ?? 0)} posted this session
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

      {error && <p className="text-error small" style={{ margin: 0 }}>{error}</p>}
      {/* Says out loud what the old frozen "1 queued" never did: a humanized post
          is slow ON PURPOSE, so minutes of apparent silence are the normal case. */}
      {status.busy && (
        <p className="text-dim small" style={{ margin: 0 }}>
          Working on a reply now — the approach plan (browse, read, skim, type) takes several
          minutes by design. Nothing is stuck.
        </p>
      )}
      {online && !status.busy && !dryRun && (
        <p className="text-dim small" style={{ margin: 0 }}>
          Live and running — approved replies will post for real.
        </p>
      )}
    </div>
  );
}
