import { NextResponse } from 'next/server';
import { requireGlobalPermission, type Caller } from '@/server/auth';
import { withAuth, badRequest } from '@/server/route';
import { runCommentScan } from '@/server/commentKarma';
import { runActor } from '@/server/llm/resolve';

// POST /api/accounts/[accountId]/comment-karma/scan — look for one comment.
//
// OPERATOR-TRIGGERED, one scan per press. There is no scheduler here and this
// deliberately does not add one: a scan spends Crawlzo calls (billed, including
// 404s) and up to three model calls, so the thing that decides how often it runs
// should be a person until the outcome data exists to justify a cadence.
//
// IT POSTS NOTHING. The scan writes a record — a comment awaiting review, an
// automatically approved one, or a reason there is no comment. The enqueue and
// the agent's kind-specific allowlist are Phase 5.

// Serverless budget. A scan is one search, up to three thread reads, and three
// model calls in sequence; the same 60s the other model-backed routes take.
export const maxDuration = 60;

type Ctx = { params: Promise<{ accountId: string }> };

export const POST = withAuth<Ctx>(async (_req: Request, caller: Caller, ctx: Ctx) => {
  requireGlobalPermission(caller, 'accounts.manage');
  const { accountId } = await ctx.params;

  try {
    const report = await runCommentScan(accountId, runActor(caller), caller.profile.displayName);
    return NextResponse.json(report);
  } catch (err) {
    // A fault has already been filed as an 'error' record by runCommentScan, so
    // the panel shows what happened either way. The message is returned rather
    // than swallowed because every one of them is actionable by the operator:
    // no Crawlzo key, no model credential, nothing tagged Comment.
    const message = err instanceof Error ? err.message : 'The scan could not run.';
    const draftId = (err as { draftId?: string }).draftId;
    return draftId
      ? NextResponse.json({ error: message, draftId }, { status: 502 })
      : badRequest(message);
  }
});
