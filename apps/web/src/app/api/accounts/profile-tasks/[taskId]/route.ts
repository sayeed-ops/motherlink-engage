import { NextResponse } from 'next/server';
import { requirePlatformAdmin, type Caller } from '@/server/auth';
import { withAuth } from '@/server/route';
import { readTask } from '@/server/profileTasks';

// GET /api/accounts/profile-tasks/[taskId] — how a proxy test or a profile
// creation is going. Never returns the proxy password or the remark.

type Ctx = { params: Promise<{ taskId: string }> };

export const GET = withAuth<Ctx>(async (_req: Request, caller: Caller, ctx: Ctx) => {
  requirePlatformAdmin(caller);
  const { taskId } = await ctx.params;
  const task = await readTask(taskId);
  if (!task) return NextResponse.json({ error: 'No such task.' }, { status: 404 });
  return NextResponse.json(task);
});
