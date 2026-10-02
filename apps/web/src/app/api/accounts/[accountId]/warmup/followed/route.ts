import { NextResponse } from 'next/server';
import { requireGlobalPermission, type Caller } from '@/server/auth';
import { withAuth, jsonBody, badRequest } from '@/server/route';
import { accountExists } from '@/server/accounts';
import { markFollowed, unmarkFollowed } from '@/server/warmup';
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
// POST marks communities as joined by hand. DELETE says the account has NOT
// joined them, and clears them from every list — the undo this route refused to
// have until a wrong "joined" turned out to be uncorrectable. See unmarkFollowed
// in server/warmup.ts for why it is safe.

type Ctx = { params: Promise<{ accountId: string }> };

async function names(req: Request): Promise<string[]> {
  const body = await jsonBody<{ subreddits?: unknown }>(req);
  return (Array.isArray(body.subreddits) ? body.subreddits : [])
    .filter((s): s is string => typeof s === 'string')
    .map(normalizeSubredditName)
    .filter(Boolean)
    .slice(0, 50);
}

export const POST = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  requireGlobalPermission(caller, 'accounts.manage');
  const { accountId } = await ctx.params;
  if (!(await accountExists(accountId))) return badRequest('No such account.');

  const subreddits = await names(req);
  if (!subreddits.length) return badRequest('No subreddit names supplied.');

  const followed = await markFollowed(accountId, subreddits, caller.uid);
  return NextResponse.json({ accountId, followed });
});

export const DELETE = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  requireGlobalPermission(caller, 'accounts.manage');
  const { accountId } = await ctx.params;
  if (!(await accountExists(accountId))) return badRequest('No such account.');

  const subreddits = await names(req);
  if (!subreddits.length) return badRequest('No subreddit names supplied.');

  const followed = await unmarkFollowed(accountId, subreddits, caller.uid);
  return NextResponse.json({ accountId, followed });
});
