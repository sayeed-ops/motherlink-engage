import { NextResponse } from 'next/server';
import { withAuth, jsonBody } from '@/server/route';
import { requireProjectPermission, type Caller } from '@/server/auth';
import { getPolicyView, saveCoversPolicy } from '@/server/coversTriage';

// GET / PUT /api/projects/:projectId/covers/policy
//
// Where the client may take customers, and which reply variants exist at all.
//
// Writing needs `project.settings`. The prohibited-jurisdiction list comes from
// a licence and turning the brand-mentioned variant on decides whether a public
// forum post names the client — neither belongs behind the same permission as
// "read two pages instead of one".

type Ctx = { params: Promise<{ projectId: string }> };

// Returns what is stored, what we WOULD derive, and what still needs a person.
// A project created before policies were seeded has no document; the derivation
// runs for it anyway so the screen opens pre-filled rather than empty.
export const GET = withAuth<Ctx>(async (_req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'project.view');
  return NextResponse.json(await getPolicyView(projectId));
});

export const PUT = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'project.settings');

  const body = await jsonBody<{ policy?: unknown }>(req);

  // The confirming person's name is recorded from the CALLER, never from the
  // request body — "who signed this off" is not a thing a request may assert.
  const input = {
    ...(body.policy && typeof body.policy === 'object' ? body.policy : {}),
    confirmedByName: caller.profile.displayName ?? '',
  };

  return NextResponse.json({ policy: await saveCoversPolicy(projectId, input, caller.uid) });
});
