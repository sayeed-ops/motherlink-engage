'use client';

import { useEffect, useState } from 'react';
import { apiPost, ApiError } from '@/lib/api';
import { subscribeDoc, agentStatusPath, agentControlPath } from '@/lib/data';
import { useAuth } from '@/lib/context/AuthContext';

// The posting agent's status + the dry-run switch, shown on the Accounts page.
// One agent, one queue, so this is global platform state.
//
// Online/offline is a pure heartbeat: the agent stamps agents/agent every ~5s;
// we call it online only if that stamp is < 20s old. Starting/stopping the agent
// PROCESS is done from the local control panel on the host (see apps/poster-agent)
// — nothing here can launch it. What this offers is the one remote control that
// matters: dry run (types the reply but never submits), which the running agent
// re-reads every poll.

const ONLINE_WINDOW_MS = 20_000;

const ms = (v: unknown): number =>
  v && typeof v === 'object' && 'toMillis' in v ? (v as { toMillis(): number }).toMillis() : 0;

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
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 5000);
    const unsubAgent = subscribeDoc<Record<string, unknown>>(agentStatusPath, setAgent);
    const unsubControl = subscribeDoc<Record<string, unknown>>(agentControlPath, setControl);
    return () => {
      clearInterval(t);
      unsubAgent();
      unsubControl();
    };
  }, []);

  const online = (() => {
    const seen = ms(agent?.lastSeenAt);
    return seen > 0 && (now || Date.now()) - seen < ONLINE_WINDOW_MS;
  })();

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
              <strong>Posting agent online</strong>
              <span className="text-dim">
                {' '}
                · {String(agent?.queued ?? 0)} queued · {String(agent?.postedSession ?? 0)} posted this session
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
      {online && !dryRun && (
        <p className="text-dim small" style={{ margin: 0 }}>
          Live and running — approved replies will post for real.
        </p>
      )}
    </div>
  );
}
