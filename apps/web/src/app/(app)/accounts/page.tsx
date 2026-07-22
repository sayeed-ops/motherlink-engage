'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Plus, Users, Trash2, X, Flame, ArrowRight } from 'lucide-react';
import PageHeader from '@/components/PageHeader';
import AgentControls from '@/components/AgentControls';
import AccountForm from '@/components/AccountForm';
import { apiFetch, ApiError } from '@/lib/api';
import { subscribe, q } from '@/lib/data';
import { accountPostGate } from '@/modules/reddit/accountGate';
import { useAuth } from '@/lib/context/AuthContext';
import type { AccountStats, RedditAccountStatus } from '@/modules/reddit/types';

// Posting identities — the Reddit accounts the tool can post FROM.
//
// This page is the roster + create surface. Each card links into the account's
// own page (/accounts/:id) where its Dashboard (karma/subs/activity) and Settings
// live. No credentials are stored here — the login lives in the account's AdsPower
// profile; `username` is only the wrong-account safeguard. Reads go straight to
// Firestore; every write goes through a server route gated on accounts.manage.

const STATUS_BADGE: Record<RedditAccountStatus, string> = {
  active: 'badge-success',
  warming: 'badge-warning',
  flagged: 'badge-warning',
  banned: 'badge',
};

interface Account {
  accountId: string;
  label: string;
  username: string;
  adsPowerProfileId: string;
  status: RedditAccountStatus;
  dailyCap: number;
  minIntervalMinutes: number;
  karma: number;
  capturedKarma: number | null;
  notes: string;
  postCountToday: number;
  postCountResetAtMs: number;
  lastPostAtMs: number;
  warmupDays: number;
}

const ms = (v: unknown): number =>
  v && typeof v === 'object' && 'toMillis' in v ? (v as { toMillis(): number }).toMillis() : 0;

export default function AccountsPage() {
  const { profile } = useAuth();
  const canManage =
    profile?.role === 'owner' ||
    profile?.role === 'admin' ||
    !!profile?.globalPermissions?.includes('accounts.manage');

  const [raw, setRaw] = useState<Record<string, unknown>[] | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Tick so the gate's time-based states (interval, rolling window) re-evaluate.
  const [now, setNow] = useState(0);

  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 10000);
    const unsub = subscribe<Record<string, unknown>>(q.accounts(), setRaw, (e) => setError(e.message));
    return () => {
      clearInterval(t);
      unsub();
    };
  }, []);

  const accounts = useMemo<Account[] | null>(() => {
    if (raw === null) return null;
    return raw
      .map((a) => {
        const stats = a.stats as AccountStats | undefined;
        return {
          accountId: a.id as string,
          label: (a.label as string) ?? '',
          username: (a.username as string) ?? '',
          adsPowerProfileId: (a.adsPowerProfileId as string) ?? '',
          status: (a.status as RedditAccountStatus) ?? 'warming',
          dailyCap: (a.dailyCap as number) ?? 0,
          minIntervalMinutes: (a.minIntervalMinutes as number) ?? 0,
          karma: (a.karma as number) ?? 0,
          capturedKarma: stats ? stats.totalKarma : null,
          notes: (a.notes as string) ?? '',
          postCountToday: (a.postCountToday as number) ?? 0,
          postCountResetAtMs: ms(a.postCountResetAt),
          lastPostAtMs: ms(a.lastPostAt),
          warmupDays: ((a.warmupPlan as { days?: unknown[] } | undefined)?.days?.length as number) ?? 0,
        };
      })
      .sort((x, y) => x.label.localeCompare(y.label));
  }, [raw]);

  async function remove(a: Account) {
    if (!confirm(`Delete account "${a.label}"? This does not delete any posted replies.`)) return;
    setError(null);
    try {
      await apiFetch(`/api/accounts/${a.accountId}`, { method: 'DELETE' });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete the account.');
    }
  }

  return (
    <>
      <PageHeader
        title="Accounts"
        description="Reddit identities the tool can post from. Each posts through its own AdsPower profile on its own sticky IP — no passwords are stored here."
        action={
          canManage && !showForm ? (
            <button className="btn btn-primary btn-sm" onClick={() => setShowForm(true)}>
              <Plus size={14} /> Add account
            </button>
          ) : undefined
        }
      />

      <div className="sections">
        <AgentControls />

        {error && !showForm && <p className="text-error small">{error}</p>}

        {showForm && (
          <section className="card">
            <div className="card-head">
              <h3>New account</h3>
              <button className="btn btn-ghost btn-sm btn-icon" onClick={() => setShowForm(false)} aria-label="Close">
                <X size={14} />
              </button>
            </div>
            <AccountForm mode="create" onDone={() => setShowForm(false)} onCancel={() => setShowForm(false)} />
          </section>
        )}

        {accounts === null && <p className="text-dim small">Loading…</p>}

        {accounts && accounts.length === 0 && !showForm && (
          <div className="card">
            <div className="empty">
              <Users size={20} className="text-faint" />
              <p>No accounts yet.</p>
              <p className="text-dim small">
                {canManage
                  ? "Add the Reddit accounts you'll post value and brand replies from."
                  : 'No posting identities have been added.'}
              </p>
            </div>
          </div>
        )}

        {accounts && accounts.length > 0 && (
          <div className="account-grid">
            {accounts.map((a) => {
              const gate = accountPostGate(a, now || Date.now());
              return (
                <article key={a.accountId} className="card">
                  <div className="card-head">
                    <div style={{ minWidth: 0 }}>
                      <Link href={`/accounts/${a.accountId}`} className="strong-link">
                        {a.label}
                      </Link>
                      {a.username && <div className="text-dim small">u/{a.username}</div>}
                    </div>
                    <span className={`badge ${STATUS_BADGE[a.status]}`}>{a.status}</span>
                  </div>

                  <div className="row" style={{ flexWrap: 'wrap', gap: 6, margin: '4px 0 12px' }}>
                    <span className="badge badge-no-dot">
                      {gate.remainingToday}/{a.dailyCap} left today
                    </span>
                    <span className="badge badge-no-dot">{a.minIntervalMinutes}m gap</span>
                    <span className="badge badge-no-dot">
                      {a.capturedKarma !== null ? `${a.capturedKarma.toLocaleString()} karma` : `${a.karma} karma*`}
                    </span>
                    <span className="badge badge-no-dot">
                      {a.adsPowerProfileId ? `profile: ${a.adsPowerProfileId}` : 'no profile id'}
                    </span>
                  </div>

                  {!gate.ok && <p className="text-warning small">{gate.reason}</p>}
                  {a.lastPostAtMs > 0 && (
                    <p className="text-faint small">Last post: {new Date(a.lastPostAtMs).toLocaleString()}</p>
                  )}
                  {a.notes && <p className="text-muted small clamp">{a.notes}</p>}

                  <div className="row" style={{ marginTop: 12, flexWrap: 'wrap' }}>
                    <Link href={`/accounts/${a.accountId}`} className="btn btn-primary btn-sm">
                      Open <ArrowRight size={12} />
                    </Link>
                    <Link href={`/accounts/${a.accountId}/warmup`} className="btn btn-secondary btn-sm">
                      <Flame size={12} /> Warm-up
                      {a.warmupDays > 0 && (
                        <span className="badge badge-no-dot badge-success" style={{ marginLeft: 4 }}>
                          {a.warmupDays}d
                        </span>
                      )}
                    </Link>
                    {canManage && (
                      <button className="btn btn-danger btn-sm" onClick={() => remove(a)}>
                        <Trash2 size={12} /> Delete
                      </button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
