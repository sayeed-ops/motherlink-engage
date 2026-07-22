'use client';

import { use, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Flame, Trash2 } from 'lucide-react';
import PageHeader from '@/components/PageHeader';
import AccountDashboard from '@/components/AccountDashboard';
import AccountForm, { type AccountFormValues } from '@/components/AccountForm';
import { subscribe, subscribeDoc, q } from '@/lib/data';
import { apiGet, apiFetch, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/context/AuthContext';
import type { AccountStatSnapshot, RedditAccountStatus } from '@/modules/reddit/types';
import type { AccountActivity } from '@/server/accountActivity';

// One account's home. Dashboard (Reddit-side stats + our activity) and Settings
// (the identity/rails form) live behind tabs; Warm-up keeps its own page, linked
// from the header. Reads the account doc + stat history live via the client SDK;
// activity is a server aggregate over `jobs`.

type Tab = 'dashboard' | 'settings';

export default function AccountDetailPage({ params }: { params: Promise<{ accountId: string }> }) {
  const { accountId } = use(params);
  const router = useRouter();
  const { profile } = useAuth();
  const canManage =
    profile?.role === 'owner' ||
    profile?.role === 'admin' ||
    !!profile?.globalPermissions?.includes('accounts.manage');

  const [tab, setTab] = useState<Tab>('dashboard');
  const [account, setAccount] = useState<Record<string, unknown> | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [snapshots, setSnapshots] = useState<AccountStatSnapshot[] | null>(null);
  // Keyed by accountId so switching accounts recomputes loading during render
  // (no synchronous setState in the effect) and never shows the prior account's data.
  const [activityState, setActivityState] = useState<{ id: string; data: AccountActivity | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const activityReady = activityState?.id === accountId;
  const activity = activityReady ? activityState!.data : null;
  const activityLoading = !activityReady;

  useEffect(() => {
    const unsubDoc = subscribeDoc<Record<string, unknown>>(['accounts', accountId], (doc) => {
      setAccount(doc);
      setLoaded(true);
    });
    const unsubSnaps = subscribe<AccountStatSnapshot>(q.statSnapshots(accountId), setSnapshots, () => setSnapshots([]));
    return () => {
      unsubDoc();
      unsubSnaps();
    };
  }, [accountId]);

  useEffect(() => {
    let alive = true;
    apiGet<AccountActivity>(`/api/accounts/${accountId}/activity`)
      .then((a) => alive && setActivityState({ id: accountId, data: a }))
      .catch(() => alive && setActivityState({ id: accountId, data: null }));
    return () => {
      alive = false;
    };
  }, [accountId]);

  const label = (account?.label as string) || 'Account';

  async function remove() {
    if (!confirm(`Delete account "${label}"? This does not delete any posted replies.`)) return;
    setError(null);
    try {
      await apiFetch(`/api/accounts/${accountId}`, { method: 'DELETE' });
      router.push('/accounts');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete the account.');
    }
  }

  const initialForm: AccountFormValues | undefined = account
    ? {
        label: (account.label as string) ?? '',
        username: (account.username as string) ?? '',
        adsPowerProfileId: (account.adsPowerProfileId as string) ?? '',
        status: ((account.status as RedditAccountStatus) ?? 'warming') as RedditAccountStatus,
        dailyCap: (account.dailyCap as number) ?? 5,
        minIntervalMinutes: (account.minIntervalMinutes as number) ?? 45,
        karma: (account.karma as number) ?? 0,
        notes: (account.notes as string) ?? '',
      }
    : undefined;

  return (
    <>
      <PageHeader
        title={label}
        description={(account?.username as string) ? `u/${account?.username as string}` : 'Posting identity'}
        crumbs={[{ label: 'Accounts', href: '/accounts' }, { label }]}
        action={
          <Link href={`/accounts/${accountId}/warmup`} className="btn btn-secondary btn-sm">
            <Flame size={13} /> Warm-up
          </Link>
        }
      />

      {!loaded ? (
        <p className="text-dim small">Loading…</p>
      ) : account === null ? (
        <div className="card">
          <p>This account does not exist.</p>
          <Link href="/accounts" className="link-row">
            Back to accounts
          </Link>
        </div>
      ) : (
        <>
          <div className="tabs">
            <button className={`tab ${tab === 'dashboard' ? 'active' : ''}`} onClick={() => setTab('dashboard')} style={{ background: 'none', border: 'none', cursor: 'pointer' }}>
              Dashboard
            </button>
            <button className={`tab ${tab === 'settings' ? 'active' : ''}`} onClick={() => setTab('settings')} style={{ background: 'none', border: 'none', cursor: 'pointer' }}>
              Settings
            </button>
          </div>

          {tab === 'dashboard' && (
            <AccountDashboard
              accountId={accountId}
              account={account}
              snapshots={snapshots}
              activity={activity}
              activityLoading={activityLoading}
              canManage={canManage}
            />
          )}

          {tab === 'settings' &&
            (canManage ? (
              <div className="sections">
                <section className="card">
                  <div className="card-head">
                    <h3>Account settings</h3>
                  </div>
                  {initialForm && (
                    <AccountForm mode="edit" accountId={accountId} initial={initialForm} onDone={() => setTab('dashboard')} />
                  )}
                </section>

                <section className="card">
                  <div className="card-head">
                    <h3>Danger zone</h3>
                  </div>
                  <p className="text-dim small">Deleting removes the identity mapping only — posted replies stay on Reddit.</p>
                  {error && <p className="text-error small">{error}</p>}
                  <button className="btn btn-danger btn-sm" onClick={remove}>
                    <Trash2 size={13} /> Delete account
                  </button>
                </section>
              </div>
            ) : (
              <div className="card">
                <p className="text-dim small" style={{ marginBottom: 0 }}>
                  You don’t have permission to edit this account.
                </p>
              </div>
            ))}
        </>
      )}
    </>
  );
}
