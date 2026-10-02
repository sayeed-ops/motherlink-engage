import { NextResponse } from 'next/server';
import { requirePlatformAdmin, type Caller } from '@/server/auth';
import { withAuth, jsonBody, badRequest } from '@/server/route';
import { deleteInstruction, setInstructionActive } from '@/server/draftingInstructions';
import { writeActivityLog } from '@/server/activityLog';

// Switch one platform instruction on/off, or delete it.
//
// There is no edit. The text is immutable once saved, so a draft's stamp always
// names one exact wording — rewording is adding a new block and deleting the
// old one, which also keeps the two comparable.

type Ctx = { params: Promise<{ instructionId: string }> };

export const PATCH = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  requirePlatformAdmin(caller);
  const { instructionId } = await ctx.params;

  const { active } = await jsonBody<{ active?: unknown }>(req);
  if (typeof active !== 'boolean') return badRequest('active must be true or false.');

  if (!(await setInstructionActive('platform', instructionId, active))) {
    return badRequest('No such instructions.');
  }

  await writeActivityLog({
    caller,
    action: 'drafting.instructions_changed',
    targetType: 'platform',
    targetId: instructionId,
    metadata: { scope: 'platform', change: active ? 'turned on' : 'turned off' },
  });

  return NextResponse.json({ active });
});

export const DELETE = withAuth<Ctx>(async (_req: Request, caller: Caller, ctx: Ctx) => {
  requirePlatformAdmin(caller);
  const { instructionId } = await ctx.params;

  if (!(await deleteInstruction('platform', instructionId))) {
    return badRequest('No such instructions.');
  }

  await writeActivityLog({
    caller,
    action: 'drafting.instructions_changed',
    targetType: 'platform',
    targetId: instructionId,
    metadata: { scope: 'platform', change: 'deleted' },
    severity: 'warning',
  });

  return NextResponse.json({ deleted: true });
});
