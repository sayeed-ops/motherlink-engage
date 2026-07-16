'use client';

import { useEffect, useMemo, useState } from 'react';
import { ScrollText } from 'lucide-react';
import PageHeader from '@/components/PageHeader';
import { useAuth } from '@/lib/context/AuthContext';
import { subscribe, q } from '@/lib/data';

// The audit trail.
//
// Reads go straight to Firestore under the activity_logs rule: a platform admin
// lists everything; anyone else sees only their own entries (the rule requires
// the userId filter, which q.myActivityLogs supplies). The nav link is
// admin-only, but the page still works for a non-admin who lands here directly —
// they just see their own actions, enforced by rules, not by this component.
//
// Entries are written server-side only (writeActivityLog). Today that is
// clean-history and delete-project; the list grows as more consequential actions
// start logging.

interface LogRow {
  id: string;
  userEmail: string;
  userRole: string;
  action: string;
  targetType: string;
  targetName: string | null;
  metadata: Record<string, unknown>;
  severity: string;
  createdAtMs: number;
}

const ACTION_LABEL: Record<string, string> = {
  'project.history_cleaned': 'Cleared Reddit history',
  'project.deleted': 'Deleted project',
};

const label = (action: string) =>
  ACTION_LABEL[action] ?? action.replace(/[._]/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

const when = (ms: number) => {
  if (!ms) return '';
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  if (m < 1440) return `${Math.round(m / 60)}h ago`;
  return new Date(ms).toLocaleDateString();
};

const severityClass = (s: string) =>
  s === 'error' ? 'badge badge-warning' : s === 'warning' ? 'badge badge-warning' : 'badge';

export default function ActivityPage() {
  const { profile } = useAuth();
  const isAdmin = profile?.role === 'owner' || profile?.role === 'admin';

  const [rows, setRows] = useState<Record<string, unknown>[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!profile) return;
    const query = isAdmin ? q.activityLogs() : q.myActivityLogs(profile.uid);
    return subscribe<Record<string, unknown>>(
      query,
      setRows,
      (e) => setError(e.message),
    );
  }, [profile, isAdmin]);

  const logs = useMemo<LogRow[] | null>(() => {
    if (rows === null) return null;
    return rows
      .map((r) => {
        const ts = r.createdAt as { toMillis?(): number } | undefined;
        return {
          id: r.id as string,
          userEmail: (r.userEmail as string) ?? 'unknown',
          userRole: (r.userRole as string) ?? '',
          action: (r.action as string) ?? '',
          targetType: (r.targetType as string) ?? '',
          targetName: (r.targetName as string) ?? null,
          metadata: (r.metadata as Record<string, unknown>) ?? {},
          severity: (r.severity as string) ?? 'info',
          createdAtMs: ts?.toMillis?.() ?? 0,
        } satisfies LogRow;
      })
      // Newest first — needed for the per-user query, which is unordered.
      .sort((a, b) => b.createdAtMs - a.createdAtMs);
  }, [rows]);

  return (
    <>
      <PageHeader
        title="Activity"
        description={
          isAdmin
            ? 'Consequential actions across Engage — who did what, and when.'
            : 'Your recent actions in Engage.'
        }
      />

      <div className="sections">
        {error && <p className="text-error small">{error}</p>}
        {logs === null && <p className="text-dim small">Loading…</p>}

        {logs && logs.length === 0 && (
          <div className="card">
            <div className="empty">
              <ScrollText size={20} className="text-faint" />
              <p>No activity yet.</p>
              <p className="text-dim small">
                Destructive actions — clearing history, deleting a project — are recorded here as they
                happen.
              </p>
            </div>
          </div>
        )}

        {logs && logs.length > 0 && (
          <section className="card">
            <ul className="list">
              {logs.map((l) => {
                const meta = Object.entries(l.metadata)
                  .filter(([, v]) => typeof v === 'number' || typeof v === 'string')
                  .map(([k, v]) => `${k} ${v}`)
                  .join(' · ');
                return (
                  <li key={l.id} className="list-row">
                    <div style={{ minWidth: 0 }}>
                      <div className="row">
                        <strong>{label(l.action)}</strong>
                        {l.severity !== 'info' && <span className={severityClass(l.severity)}>{l.severity}</span>}
                      </div>
                      <div className="text-dim small">
                        {l.targetName ? `${l.targetName} · ` : ''}
                        {l.targetType}
                        {isAdmin ? ` · ${l.userEmail}` : ''}
                      </div>
                      {meta && <div className="text-faint small">{meta}</div>}
                    </div>
                    <span className="text-dim small">{when(l.createdAtMs)}</span>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </div>
    </>
  );
}
