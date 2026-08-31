import { NextResponse } from 'next/server';
import { withAuth, jsonBody } from '@/server/route';
import { requireProjectPermission, type Caller } from '@/server/auth';
import { getCoversPolicy, saveCoversPolicy } from '@/server/coversTriage';

// GET / PUT /api/projects/:projectId/covers/policy
//
// Where the client may take customers, and which reply variants exist at all.
//
// Writing needs `project.settings`. The prohibited-jurisdiction list comes from
// a licence and turning the brand-mentioned variant on decides whether a public
// forum post names the client — neither belongs behind the same permission as
// "read two pages instead of one".

type Ctx = { params: Promise<{ projectId: string }> };

export const GET = withAuth<Ctx>(async (_req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'project.view');
  return NextResponse.json({ policy: await getCoversPolicy(projectId) });
});

export const PUT = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'project.settings');

  const body = await jsonBody<{ policy?: unknown }>(req);
  return NextResponse.json({ policy: await saveCoversPolicy(projectId, body.policy, caller.uid) });
});
