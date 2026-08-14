import { NextResponse } from 'next/server';
import { requireGlobalPermission, type Caller } from '@/server/auth';
import { withAuth, jsonBody, badRequest } from '@/server/route';
import { accountExists } from '@/server/accounts';
import { saveWarmupPolicy } from '@/server/warmup';
import { normalizeWarmupPolicy } from '@/modules/reddit/warmupWalk';

// The account's warm-up POLICY — the tunable behaviour of the browsing walk and
// the follow pace.
//
// Note what is deliberately NOT stored here: `subreddits`, `searchTargets`,
// `joinTargets`, `keywords` and `keywordsByCommunity` are all DERIVED from the
// community list at compose time, in the run route. Storing a second copy on the
// policy would let the two drift, and the drifted one would be invisible — the
// walk would quietly aim at communities the operator had removed.

type Ctx = { params: Promise<{ accountId: string }> };

export const PUT = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  requireGlobalPermission(caller, 'accounts.manage');
  const { accountId } = await ctx.params;

  if (!(await accountExists(accountId))) return badRequest('No such account.');

  const body = await jsonBody<{ policy?: unknown }>(req);
  const policy = normalizeWarmupPolicy(body.policy);
  if (!policy) return badRequest('That policy is empty or malformed.');

  // Only the behavioural half is persisted. The list-shaped fields are rebuilt
  // from the community list on every run.
  await saveWarmupPolicy(
    accountId,
    { version: 1, upvoteCurve: policy.upvoteCurve, follow: policy.follow, entryMix: policy.entryMix,
      popularSessionChance: policy.popularSessionChance, newsSessionChance: policy.newsSessionChance,
      transitionWeights: policy.transitionWeights, sessionLength: policy.sessionLength },
    caller.uid,
  );
  return NextResponse.json({ accountId, policy });
});
