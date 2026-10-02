import { NextResponse } from 'next/server';
import { requireGlobalPermission, type Caller } from '@/server/auth';
import { withAuth, badRequest } from '@/server/route';
import { getAccount, saveForumStats } from '@/server/accounts';
import { accountPlatform } from '@/modules/accounts/platform';
import { fetchForumUser, ShopifyReadError } from '@/modules/shopify/reader';
import { ForumUserNotFound, parseForumUser } from '@/modules/shopify/forumUser';

// POST /api/accounts/:accountId/forum-stats — read a Shopify Community account's
// public standing (trust level, joined, time read) and store it.
//
// A PUBLIC read of the user's profile JSON, from the server, on request. Unlike
// Reddit stats — which the agent captures in-session so a central crawler never
// ties the accounts together — this is one request to a public endpoint that
// any visitor's browser makes when opening a profile, made only when a person
// presses Refresh. Gated on accounts.manage like every account write.

type Ctx = { params: Promise<{ accountId: string }> };

export const POST = withAuth<Ctx>(async (_req: Request, caller: Caller, ctx: Ctx) => {
  requireGlobalPermission(caller, 'accounts.manage');
  const { accountId } = await ctx.params;

  const account = await getAccount(accountId);
  if (!account) return badRequest('No such account.');
  if (accountPlatform(account) !== 'shopify') return badRequest('Forum standing is only read for Shopify Community accounts.');
  const username = String(account.username || '').trim();
  if (!username) return badRequest('This account has no forum username.');

  try {
    const stats = parseForumUser(await fetchForumUser(username), Date.now());
    await saveForumStats(accountId, { ...stats });
    return NextResponse.json({ forumStats: stats });
  } catch (err) {
    if (err instanceof ShopifyReadError) {
      return badRequest(err.status === 404 ? `No Shopify Community user called "${username}".` : err.message);
    }
    if (err instanceof ForumUserNotFound) return badRequest(err.message);
    throw err;
  }
});
