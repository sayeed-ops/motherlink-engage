import { NextResponse } from 'next/server';
import { requireGlobalPermission, type Caller } from '@/server/auth';
import { withAuth } from '@/server/route';
import { wakeAgent } from '@/server/agentWake';

// POST /api/agent/wake — start the agent's cloud server now, without queueing a
// task. For connecting to it, or to have it warm before a batch of work. Same
// gate as the other agent controls.

export const POST = withAuth(async (_req: Request, caller: Caller) => {
  requireGlobalPermission(caller, 'accounts.manage');
  const outcome = await wakeAgent(`button: ${caller.profile.displayName || caller.uid}`);
  return NextResponse.json({ outcome });
});
