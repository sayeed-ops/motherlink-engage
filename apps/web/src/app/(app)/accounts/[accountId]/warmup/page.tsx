'use client';

import { use, useEffect, useState } from 'react';
import PageHeader from '@/components/PageHeader';
import WarmupDesigner from '@/components/WarmupDesigner';
import WarmupLoopPanel from '@/components/WarmupLoopPanel';
import { subscribeDoc } from '@/lib/data';
import { useAuth } from '@/lib/context/AuthContext';
import type { WarmupPlan } from '@/modules/reddit/warmup';

// Two models, deliberately side by side.
//
// "Browsing loop" composes a fresh stochastic session every run, from a policy,
// and can only emit actions the agent actually has a primitive for.
//
// "Package designer" is the older hand-authored day timeline. Kept because it is
// a good way to sketch a schedule, but note it can emit actions with no primitive
// behind them (save_post, follow_post, join_subreddit, view_profile,
// expand_comments, idle) — the agent silently skips those, so a designer plan can
// report success having done a fraction of what it said. The loop tab has no such
// gap. Once the missing primitives exist, the two can converge.
type Tab = 'loop' | 'designer';

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

  const [tab, setTab] = useState<Tab>('loop');
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

  // Subreddits the walk may open directly or search for. Falls back to nothing,
  // which the loop handles by entering only via Home / r/popular / r/news — a
  // brand-new account genuinely has nowhere else to go.
  const subreddits = Array.isArray(account?.warmupSubreddits)
    ? (account.warmupSubreddits as unknown[]).filter((s): s is string => typeof s === 'string')
    : [];
  // Wall-clock, not a stored cursor: the ramp models how long the account has
  // existed, which does not pause when the posting Mac is off.
  const startedAt = account?.warmupStartedAt as { seconds?: number } | undefined;
  const warmupStartedAtMs = startedAt?.seconds ? startedAt.seconds * 1000 : null;

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
        <>
          <div className="tabs">
            <button
              className={`tab ${tab === 'loop' ? 'active' : ''}`}
              onClick={() => setTab('loop')}
              style={{ background: 'none', border: 'none', cursor: 'pointer' }}
            >
              Browsing loop
            </button>
            <button
              className={`tab ${tab === 'designer' ? 'active' : ''}`}
              onClick={() => setTab('designer')}
              style={{ background: 'none', border: 'none', cursor: 'pointer' }}
            >
              Package designer
            </button>
          </div>

          {tab === 'loop' ? (
            <WarmupLoopPanel
              key={accountId}
              accountId={accountId}
              subreddits={subreddits}
              startedAtMs={warmupStartedAtMs}
              canManage={canManage}
            />
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
      )}
    </>
  );
}
