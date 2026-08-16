import { NextResponse } from 'next/server';
import { requireGlobalPermission, type Caller } from '@/server/auth';
import { withAuth, jsonBody, badRequest } from '@/server/route';
import { accountExists } from '@/server/accounts';
import { saveCommentSettings } from '@/server/commentKarma';
import type { CommentKarmaSettings } from '@/modules/reddit/commentKarma/settings';

// The account's comment-karma settings — the switch, the persona, the rails.
//
// Note what is NOT stored here: which communities to comment in. Those are the
// Comment-tagged entries on the Communities tab, read at scan time, for the same
// reason the warm-up policy does not store its subreddit list — a second copy
// drifts, and the drifted copy is invisible.

type Ctx = { params: Promise<{ accountId: string }> };

export const PUT = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  // Same gate as the rest of warm-up: this decides what a real Reddit identity
  // will say in public.
  requireGlobalPermission(caller, 'accounts.manage');
  const { accountId } = await ctx.params;

  if (!(await accountExists(accountId))) return badRequest('No such account.');

  const body = await jsonBody<{ settings?: Partial<CommentKarmaSettings> }>(req);
  if (!body.settings || typeof body.settings !== 'object') {
    return badRequest('No settings supplied.');
  }

  // Normalising, not validating: every field has a safe default, so a partial
  // body from an older client saves the account rather than failing it.
  const settings = await saveCommentSettings(accountId, body.settings, caller.uid);
  return NextResponse.json({ accountId, settings });
});
