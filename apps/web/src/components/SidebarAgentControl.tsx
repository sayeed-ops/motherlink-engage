'use client';

import { useEffect, useState } from 'react';
import { apiPost, ApiError } from '@/lib/api';
import { subscribeDoc, agentStatusPath, agentControlPath } from '@/lib/data';
import { readAgentStatus } from '@/lib/agentStatus';
import { useAuth } from '@/lib/context/AuthContext';

// Compact dry-run switch for the sidebar, so the one control that matters — live
// vs dry — is always one click away, not buried on the Accounts page. Same global
// state (agents/control.dryRun) as the fuller AgentControls chip; they stay in
// sync because both subscribe to the same doc. Only rendered for people who can
// manage accounts (the ones who post).
//
// The status line reads "online · posting r/x · 3m" while a job runs — see
// lib/agentStatus.ts for why a bare queue count wasn't enough.

export default function SidebarAgentControl() {
  const { profile } = useAuth();
  const canManage =
    profile?.role === 'owner' ||
    profile?.role === 'admin' ||
    !!profile?.globalPermissions?.includes('accounts.manage');

  const [agent, setAgent] = useState<Record<string, unknown> | null>(null);
  const [control, setControl] = useState<Record<string, unknown> | null>(null);
  // `now` is state, ticked from an effect, so freshness and the job's elapsed
  // time both re-evaluate on a timer without a Date.now() call in the render body.
  const [now, setNow] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!canManage) return;
    // `now` is only ever advanced from a callback (the tick or a snapshot), never
    // from the effect body — setting state synchronously during an effect is what
    // react-hooks/set-state-in-effect forbids. It stays 0 until the first
    // snapshot lands, which readAgentStatus reads as "not known yet ⇒ offline".
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
  }, [canManage]);

  const status = readAgentStatus(agent, now);

  if (!canManage) return null;

  const dryRun =
    typeof control?.dryRun === 'boolean'
      ? (control.dryRun as boolean)
      : typeof agent?.dryRun === 'boolean'
        ? (agent.dryRun as boolean)
        : true; // safest default: assume dry-run until we know

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
    <div className="nav-section">
      <p className="nav-title">Posting agent</p>
      <div className="agent-status-row">
        <span className={`dot ${status.online ? 'on' : 'off'}`} />
        <span title={status.current ? `job ${status.current.jobId}` : undefined}>
          {status.online ? `online · ${status.activity}` : 'offline'}
        </span>
      </div>
      <button
        className="agent-toggle"
        onClick={toggleDryRun}
        disabled={busy}
        aria-pressed={!dryRun}
        title={
          dryRun
            ? 'Dry run is ON — the agent types but never submits. Click to go LIVE.'
            : 'LIVE — approved replies post for real. Click to switch to dry run.'
        }
      >
        <span>{busy ? 'Saving…' : dryRun ? 'Dry run' : 'Live — posting'}</span>
        <span className="switch" data-on={!dryRun}>
          <span className="knob" />
        </span>
      </button>
      {error && (
        <p className="text-error small" style={{ margin: '4px 10px 0' }}>
          {error}
        </p>
      )}
    </div>
  );
}
