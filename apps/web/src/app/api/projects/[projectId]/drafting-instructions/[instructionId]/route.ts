import { NextResponse } from 'next/server';
import { requireProjectPermission, type Caller } from '@/server/auth';
import { withAuth, jsonBody, badRequest } from '@/server/route';
import { deleteInstruction, setInstructionActive } from '@/server/draftingInstructions';
import { writeActivityLog } from '@/server/activityLog';

// Switch one project instruction on/off, or delete it. No edit — see the
// platform route for why the text is immutable.

type Ctx = { params: Promise<{ projectId: string; instructionId: string }> };

export const PATCH = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId, instructionId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'project.edit');

  const { active } = await jsonBody<{ active?: unknown }>(req);
  if (typeof active !== 'boolean') return badRequest('active must be true or false.');

  if (!(await setInstructionActive('project', instructionId, active, projectId))) {
    return badRequest('No such instructions.');
  }

  await writeActivityLog({
    caller,
    action: 'drafting.instructions_changed',
    targetType: 'project',
    targetId: projectId,
    metadata: { scope: 'project', change: active ? 'turned on' : 'turned off' },
  });

  return NextResponse.json({ active });
});

export const DELETE = withAuth<Ctx>(async (_req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId, instructionId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'project.edit');

  if (!(await deleteInstruction('project', instructionId, projectId))) {
    return badRequest('No such instructions.');
  }

  await writeActivityLog({
    caller,
    action: 'drafting.instructions_changed',
    targetType: 'project',
    targetId: projectId,
    metadata: { scope: 'project', change: 'deleted' },
    severity: 'warning',
  });

  return NextResponse.json({ deleted: true });
});
