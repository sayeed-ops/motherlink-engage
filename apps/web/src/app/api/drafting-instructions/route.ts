import { NextResponse } from 'next/server';
import { requirePlatformAdmin, type Caller } from '@/server/auth';
import { withAuth, jsonBody, badRequest } from '@/server/route';
import { createInstruction, listInstructions } from '@/server/draftingInstructions';
import { instructionRefusal } from '@/modules/drafting/instructions';
import { writeActivityLog } from '@/server/activityLog';

// The PLATFORM drafting instructions — the house style every project's Reddit
// drafting is written under.
//
// Platform admin only, and that is the whole reason this is a separate
// collection from a project's own: adding a block here changes how every
// client's replies read, at once, with no deploy. A project's set is
// `project.edit` and reaches one client.
//
// Reading is open to any signed-in caller: the project screens show which
// instructions a draft was written under, and hiding the house style from the
// people working the queue would make those stamps unreadable.

export const GET = withAuth(async () => {
  return NextResponse.json({ instructions: await listInstructions('platform') });
});

export const POST = withAuth(async (req: Request, caller: Caller) => {
  requirePlatformAdmin(caller);

  const { title, body } = await jsonBody<{ title?: string; body?: string }>(req);
  const refusal = instructionRefusal(String(title ?? ''), String(body ?? ''));
  if (refusal) return badRequest(refusal);

  const created = await createInstruction({
    scope: 'platform',
    title: String(title),
    body: String(body),
    uid: caller.uid,
    name: caller.profile.displayName,
  });

  await writeActivityLog({
    caller,
    action: 'drafting.instructions_changed',
    targetType: 'platform',
    targetId: created.instructionId,
    targetName: created.title,
    metadata: { scope: 'platform', change: 'created', chars: created.body.length },
  });

  return NextResponse.json({ instruction: created }, { status: 201 });
});
