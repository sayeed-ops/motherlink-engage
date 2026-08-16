import { NextResponse } from 'next/server';
import { requireGlobalPermission, type Caller } from '@/server/auth';
import { withAuth, jsonBody, badRequest } from '@/server/route';
import { accountExists } from '@/server/accounts';
import { markFollowed } from '@/server/warmup';
import { normalizeSubredditName } from '@/modules/reddit/subreddits';

// "I already joined this one myself."
//
// The agent normally discovers what an account follows by reading its
// subscriptions during a warm-up session, occasionally, and merging the result.
// That remains the authority — but it only happens when a session runs, and an
// operator who joins a community by hand has no way to say so until then.
// Meanwhile the composer keeps aiming join legs at a community the account is
// already in, where the join primitive correctly reads the button and skips.
// Wasted legs, and a Communities tab showing the wrong state.
//
// ADDITIVE ONLY, and that is deliberate rather than lazy. The agent\'s capture is
// additive for a documented reason: an unverified parse must never be allowed to
// SHRINK the known set, because a false "not followed" makes the composer try to
// join a community it is already in — and Reddit\'s control toggles Join <->
// Joined, so that click would LEAVE it. A remove button here would hand the same
// footgun to a human, so this route cannot unfollow, and neither can anything
// else in the app.

type Ctx = { params: Promise<{ accountId: string }> };

export const POST = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  requireGlobalPermission(caller, 'accounts.manage');
  const { accountId } = await ctx.params;

  if (!(await accountExists(accountId))) return badRequest('No such account.');

  const body = await jsonBody<{ subreddits?: unknown }>(req);
  const subreddits = (Array.isArray(body.subreddits) ? body.subreddits : [])
    .filter((s): s is string => typeof s === 'string')
    .map(normalizeSubredditName)
    .filter(Boolean)
    .slice(0, 50);

  if (!subreddits.length) return badRequest('No subreddit names supplied.');

  const followed = await markFollowed(accountId, subreddits, caller.uid);
  return NextResponse.json({ accountId, followed });
});
