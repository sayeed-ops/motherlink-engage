'use client';

import { use, useEffect, useState } from 'react';
import PageHeader from '@/components/PageHeader';
import WarmupDesigner from '@/components/WarmupDesigner';
import { subscribeDoc } from '@/lib/data';
import { useAuth } from '@/lib/context/AuthContext';
import type { WarmupPlan } from '@/modules/reddit/warmup';

// Warm-up designer for one account. Reads the single account doc live (the plan
// rides on it as `warmupPlan`); writes go through the gated server routes. We
// wait for the doc to load before mounting the designer so it seeds its working
// copy from the saved plan exactly once.

export default function AccountWarmupPage({ params }: { params: Promise<{ accountId: string }> }) {
  const { accountId } = use(params);
  const { profile } = useAuth();
  const canManage =
    profile?.role === 'owner' ||
    profile?.role === 'admin' ||
    !!profile?.globalPermissions?.includes('accounts.manage');

  const [account, setAccount] = useState<Record<string, unknown> | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const unsub = subscribeDoc<Record<string, unknown>>(['accounts', accountId], (doc) => {
      setAccount(doc);
      setLoaded(true);
    });
    return unsub;
  }, [accountId]);

  const label = (account?.label as string) || 'Account';
  const plan = (account?.warmupPlan as WarmupPlan | undefined) ?? null;

  return (
    <>
      <PageHeader
        title={`Warm-up — ${label}`}
        description="Design a multi-day, human-like activity schedule that ages this account before it posts."
        crumbs={[{ label: 'Accounts', href: '/accounts' }, { label: 'Warm-up' }]}
      />

      {!loaded ? (
        <p className="text-dim small">Loading…</p>
      ) : account === null ? (
        <div className="card">
          <p>This account does not exist.</p>
        </div>
      ) : (
        <WarmupDesigner
          key={accountId}
          accountId={accountId}
          hasSavedPlan={!!plan}
          initialPlan={plan}
          keywords={[]}
          canManage={canManage}
        />
      )}
    </>
  );
}
