import { NextResponse } from 'next/server';
import { withAuth } from '@/server/route';
import { requireProjectPermission, type Caller } from '@/server/auth';
import { copySourcesFromReddit } from '@/server/shopifyKnowledge';

// POST /api/projects/:projectId/shopify/knowledge/sync — copy Reddit's sources across
//
// ⚠️ ADDS WHAT IS MISSING. NEVER REPLACES, NEVER DELETES. A source held here —
// copied before (even if edited since), or with the same URL or title — is left
// exactly as it is. See modules/shopify/knowledge.ts for why a list sync cannot
// behave like the client profile's replace.

type Ctx = { params: Promise<{ projectId: string }> };

export const POST = withAuth<Ctx>(async (_req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'knowledge.manage');
  return NextResponse.json(await copySourcesFromReddit(projectId, caller.uid));
});
