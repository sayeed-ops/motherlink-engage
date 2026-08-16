'use client';

import { use, useEffect, useState } from 'react';
import PageHeader from '@/components/PageHeader';
import WarmupDesigner from '@/components/WarmupDesigner';
import WarmupLoopPanel from '@/components/WarmupLoopPanel';
import WarmupCommunitiesPanel from '@/components/WarmupCommunitiesPanel';
import WarmupComingSoon from '@/components/WarmupComingSoon';
import CommentKarmaPanel from '@/components/CommentKarmaPanel';
import { subscribeDoc } from '@/lib/data';
import { useAuth } from '@/lib/context/AuthContext';
import {
  communitiesForRole,
  keywordsByCommunity,
  normalizeCommunityList,
  normalizeKeywordList,
  normalizeSubredditList,
} from '@/modules/reddit/subreddits';
import { normalizeWarmupPolicy, warmupBoldnessDay, DEFAULT_POLICY } from '@/modules/reddit/warmupWalk';
import { commentPairs } from '@/modules/reddit/commentKarma/settings';
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
// Tab names are PROVISIONAL. They accumulate as components land and get a
// coherent renaming pass once the full set exists and the naming makes sense as
// a whole, rather than being renamed piecemeal four times.
type Tab = 'loop' | 'communities' | 'comments' | 'posts' | 'designer';

const TABS: { id: Tab; label: string }[] = [
  { id: 'loop', label: 'Browsing loop' },
  // Communities and Following were two tabs and that was wrong: you chose what to
  // follow in one place and tuned how following happens in another, with no way
  // to see the effect of either on the other. They are one decision.
  { id: 'communities', label: 'Communities' },
  { id: 'comments', label: 'Comment karma' },
  { id: 'posts', label: 'Post karma' },
  { id: 'designer', label: 'Package designer' },
];

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
  const [nowMs] = useState(() => Date.now());
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

  // The account's community list, and the browse-tagged subset the walk may open
  // directly or search for. Falls back to the legacy flat `warmupSubreddits` so
  // an account saved before the tagged list existed still composes as it did,
  // and to nothing at all — which the loop handles by entering only via Home /
  // r/popular / r/news, since a brand-new account genuinely has nowhere else.
  const communities = normalizeCommunityList(account?.warmupCommunities);
  const tagged = communitiesForRole(communities, 'browse');
  const subreddits = tagged.length ? tagged : normalizeSubredditList(account?.warmupSubreddits);

  // Wall-clock, not a stored cursor: AGE models how long the account has existed,
  // which does not pause when the posting Mac is off. EXPERIENCE is sessions
  // actually completed. The loop panel takes the lower of the two.
  const startedAt = account?.warmupStartedAt as { seconds?: number } | undefined;
  const warmupStartedAtMs = startedAt?.seconds ? startedAt.seconds * 1000 : null;
  const sessionsCompleted = Number(account?.warmupSessionsCompleted) || 0;
  // `now` is captured ONCE into state rather than read during render — reading
  // the clock in a render body is impure, and it would also make the derived day
  // change under any re-render.
  const ageDay = warmupStartedAtMs ? Math.max(1, Math.floor((nowMs - warmupStartedAtMs) / 86_400_000) + 1) : 1;
  const boldnessDay = warmupBoldnessDay(ageDay, sessionsCompleted);

  const keywords = normalizeKeywordList(account?.warmupKeywords);
  const keywordPairs = keywordsByCommunity(communities);
  // Confirmed by reading the button after the click, never merely attempted.
  const followed = normalizeSubredditList(account?.followedSubreddits);
  // Derived exactly as the run route derives them, so the preview and the queued
  // session compose from identical inputs.
  const joinTargets = communitiesForRole(communities, 'follow').filter((s) => !followed.includes(s));
  // Where comment karma may look AND what it may search for. Derived from the
  // same list rather than stored separately, for the same reason the walk
  // derives its targets: a second copy drifts, and the drifted one is
  // invisible. The server scans from this same helper.
  const commentTargets = commentPairs(communities, keywords);

  // The SAME base the run route composes from. Both sides must start here or the
  // same seed would produce different plans and the preview would quietly stop
  // matching what runs.
  const savedPolicy = normalizeWarmupPolicy(account?.warmupPolicy) ?? DEFAULT_POLICY;

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
            {TABS.map((t) => (
              <button
                key={t.id}
                className={`tab ${tab === t.id ? 'active' : ''}`}
                onClick={() => setTab(t.id)}
                style={{ background: 'none', border: 'none', cursor: 'pointer' }}
              >
                {t.label}
              </button>
            ))}
          </div>

          {tab === 'loop' && (
            <WarmupLoopPanel
              key={accountId}
              accountId={accountId}
              subreddits={subreddits}
              joinTargets={joinTargets}
              keywords={keywords}
              keywordPairs={keywordPairs}
              savedPolicy={savedPolicy}
              startedAtMs={warmupStartedAtMs}
              sessionsCompleted={sessionsCompleted}
              canManage={canManage}
            />
          )}

          {tab === 'communities' && (
            <WarmupCommunitiesPanel
              key={accountId}
              accountId={accountId}
              initial={communities}
              initialKeywords={keywords}
              followed={followed}
              savedPolicy={savedPolicy}
              day={boldnessDay}
              canManage={canManage}
            />
          )}

          {tab === 'comments' && (
            <CommentKarmaPanel
              key={accountId}
              accountId={accountId}
              saved={account?.commentKarma}
              pairs={commentTargets}
              canManage={canManage}
            />
          )}

          {tab === 'posts' && (
            <WarmupComingSoon
              title="Post karma"
              summary={
                <>
                  Submissions to communities open to new posters, aimed at attracting genuine engagement, in the
                  communities tagged <strong>Post</strong>.
                </>
              }
              notYet={
                <>
                  The only genuinely intent-first component — a person opens Reddit <em>in order to</em> submit, which
                  is why this is a session flavour rather than a budget spent inside a browse. It is also the most
                  visible and least reversible action in the system, so it is last.
                </>
              }
              depends={[
                'A submit primitive — none exists, and new reddit’s composer took substantial DOM archaeology the last time.',
                'Karma and account-age gates on most subreddits, which the readiness ledger has to model first.',
                'Comment karma landing first — a submission from an account with no comment history is the weakest possible post.',
              ]}
            />
          )}

          {tab === 'designer' && (
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
