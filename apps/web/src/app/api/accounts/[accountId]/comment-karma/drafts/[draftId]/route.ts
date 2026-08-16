import { NextResponse } from 'next/server';
import { requireGlobalPermission, type Caller } from '@/server/auth';
import { withAuth, jsonBody, badRequest } from '@/server/route';
import { reviewDraft } from '@/server/commentKarma';
import type { ReviewAction } from '@/modules/reddit/commentKarma/drafts';

// PATCH — approve or reject one drafted comment.
//
// APPROVING DOES NOT POST. It marks the draft as the one to use; the enqueue,
// the separate comment counters and the agent's kind-specific allowlist are
// Phase 5. Until then approval is a decision recorded, and the only way a
// comment reaches Reddit is a person typing it.
//
// The transition itself is transactional in reviewDraft, because approval is a
// race — two operators with the panel open, or an operator and the account's
// auto switch.

type Ctx = { params: Promise<{ accountId: string; draftId: string }> };

const ACTIONS: readonly ReviewAction[] = ['approve', 'reject'];

export const PATCH = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  requireGlobalPermission(caller, 'accounts.manage');
  const { accountId, draftId } = await ctx.params;

  const body = await jsonBody<{ action?: string; note?: string }>(req);
  const action = ACTIONS.find((a) => a === body.action);
  if (!action) return badRequest('Action must be "approve" or "reject".');

  try {
    const draft = await reviewDraft(accountId, draftId, action, typeof body.note === 'string' ? body.note : '', {
      uid: caller.uid,
      name: caller.profile.displayName,
    });
    return NextResponse.json({ draft });
  } catch (err) {
    // "already approved" and "no such draft" are both the operator's business,
    // and both are 400s rather than 500s — nothing went wrong on our side.
    return badRequest(err instanceof Error ? err.message : 'That draft could not be reviewed.');
  }
});
