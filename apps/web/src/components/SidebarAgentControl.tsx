'use client';

import { useEffect, useState } from 'react';
import { apiPost, ApiError } from '@/lib/api';
import { subscribeDoc, agentStatusPath, agentControlPath } from '@/lib/data';
import { useAuth } from '@/lib/context/AuthContext';

// Compact dry-run switch for the sidebar, so the one control that matters — live
// vs dry — is always one click away, not buried on the Accounts page. Same global
// state (agents/control.dryRun) as the fuller AgentControls chip; they stay in
// sync because both subscribe to the same doc. Only rendered for people who can
// manage accounts (the ones who post).

const ONLINE_WINDOW_MS = 20_000;

const ms = (v: unknown): number =>
  v && typeof v === 'object' && 'toMillis' in v ? (v as { toMillis(): number }).toMillis() : 0;

export default function SidebarAgentControl() {
  const { profile } = useAuth();
  const canManage =
    profile?.role === 'owner' ||
    profile?.role === 'admin' ||
    !!profile?.globalPermissions?.includes('accounts.manage');

  const [agent, setAgent] = useState<Record<string, unknown> | null>(null);
  const [control, setControl] = useState<Record<string, unknown> | null>(null);
  const [online, setOnline] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!canManage) return;
    // Track the latest heartbeat and recompute online in callbacks (never during
    // render), so the freshness check re-evaluates on each tick without a
    // Date.now() call in the render body.
    let latest: Record<string, unknown> | null = null;
    const recompute = () => {
      const seen = ms(latest?.lastSeenAt);
      setOnline(seen > 0 && Date.now() - seen < ONLINE_WINDOW_MS);
    };
    const t = setInterval(recompute, 5000);
    const unsubAgent = subscribeDoc<Record<string, unknown>>(agentStatusPath, (d) => {
      latest = d;
      setAgent(d);
      recompute();
    });
    const unsubControl = subscribeDoc<Record<string, unknown>>(agentControlPath, setControl);
    return () => {
      clearInterval(t);
      unsubAgent();
      unsubControl();
    };
  }, [canManage]);

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
        <span className={`dot ${online ? 'on' : 'off'}`} />
        <span>{online ? `online · ${String(agent?.queued ?? 0)} queued` : 'offline'}</span>
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
