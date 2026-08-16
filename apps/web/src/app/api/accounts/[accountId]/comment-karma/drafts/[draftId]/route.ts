import { NextResponse } from 'next/server';
import { requireGlobalPermission, type Caller } from '@/server/auth';
import { withAuth, jsonBody, badRequest } from '@/server/route';
import { enqueueApprovedComment, reviewDraft } from '@/server/commentKarma';
import type { ReviewAction } from '@/modules/reddit/commentKarma/drafts';

// PATCH — approve or reject one drafted comment.
//
// APPROVING QUEUES IT. The account will walk to the thread and post it, so this
// is the irreversible click, and it is gated on `accounts.manage` for the same
// reason publishing a reply is gated on `drafts.publish`.
//
// Approval and enqueue are two steps rather than one write, and the response
// says which of them happened. A comment can be approved and still refused by
// the rails — stale thread, daily cap, already commented in that community
// today, another job in flight — and every one of those is a rail working. The
// draft stays approved and can be queued again later.
//
// The transition itself is transactional in reviewDraft, because approval is a
// race — two operators with the panel open, or an operator and the account's
// auto switch.

type Ctx = { params: Promise<{ accountId: string; draftId: string }> };

const ACTIONS: readonly ReviewAction[] = ['approve', 'reject'];

/** Queueing an ALREADY-approved draft is a third action, not a second approval.
 *
 *  It exists because "approved but not queued" is a normal outcome — the rails
 *  refuse for a reason that expires (another job in flight, the daily cap, the
 *  minimum interval), and without this the draft would be stranded in a state
 *  the panel could see and not act on. It re-runs every check, so a comment that
 *  went stale while it waited is still refused. */
const QUEUE_ACTION = 'queue';

export const PATCH = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  requireGlobalPermission(caller, 'accounts.manage');
  const { accountId, draftId } = await ctx.params;

  const body = await jsonBody<{ action?: string; note?: string }>(req);
  if (body.action === QUEUE_ACTION) {
    const enqueue = await enqueueApprovedComment(accountId, draftId, {
      uid: caller.uid,
      name: caller.profile.displayName,
    });
    return NextResponse.json({ enqueue });
  }

  const action = ACTIONS.find((a) => a === body.action);
  if (!action) return badRequest('Action must be "approve", "reject" or "queue".');

  try {
    const draft = await reviewDraft(accountId, draftId, action, typeof body.note === 'string' ? body.note : '', {
      uid: caller.uid,
      name: caller.profile.displayName,
    });

    // Only an approval queues. A rejection is the end of that comment's life,
    // and its note is the training data.
    const enqueue =
      action === 'approve'
        ? await enqueueApprovedComment(accountId, draftId, {
            uid: caller.uid,
            name: caller.profile.displayName,
          })
        : undefined;

    return NextResponse.json({ draft, enqueue });
  } catch (err) {
    // "already approved" and "no such draft" are both the operator's business,
    // and both are 400s rather than 500s — nothing went wrong on our side.
    return badRequest(err instanceof Error ? err.message : 'That draft could not be reviewed.');
  }
});
