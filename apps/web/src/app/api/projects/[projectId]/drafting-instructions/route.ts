import { NextResponse } from 'next/server';
import { requireProjectPermission, type Caller } from '@/server/auth';
import { withAuth, jsonBody, badRequest } from '@/server/route';
import { createInstruction, listInstructions } from '@/server/draftingInstructions';
import { instructionRefusal } from '@/modules/drafting/instructions';
import { writeActivityLog } from '@/server/activityLog';

// One client's own drafting instructions — read on top of the platform house
// style, never instead of it.
//
// `project.edit`, the same permission as the subreddits and the forbidden
// phrases: this is configuration for one client's replies. The platform set is
// admin-only because changing it changes every client at once.

type Ctx = { params: Promise<{ projectId: string }> };

export const GET = withAuth<Ctx>(async (_req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'project.view');
  return NextResponse.json({ instructions: await listInstructions('project', projectId) });
});

export const POST = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'project.edit');

  const { title, body } = await jsonBody<{ title?: string; body?: string }>(req);
  const refusal = instructionRefusal(String(title ?? ''), String(body ?? ''));
  if (refusal) return badRequest(refusal);

  const created = await createInstruction({
    scope: 'project',
    projectId,
    title: String(title),
    body: String(body),
    uid: caller.uid,
    name: caller.profile.displayName,
  });

  await writeActivityLog({
    caller,
    action: 'drafting.instructions_changed',
    targetType: 'project',
    targetId: projectId,
    targetName: created.title,
    metadata: { scope: 'project', change: 'created', chars: created.body.length },
  });

  return NextResponse.json({ instruction: created }, { status: 201 });
});
