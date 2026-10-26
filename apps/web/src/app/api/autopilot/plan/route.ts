import { NextResponse } from 'next/server';
import { requirePlatformAdmin, type Caller } from '@/server/auth';
import { withAuth } from '@/server/route';
import { runAutopilotTick } from '@/server/autopilot';

// POST /api/autopilot/plan — run the planning pass now, for every account on
// autopilot whose day is due. The 5-minute wake-check runs the same pass on the
// live site; this is the same thing on demand (and the only trigger on a local
// dev server, which the AWS timer does not reach).

export const POST = withAuth(async (_req: Request, caller: Caller) => {
  requirePlatformAdmin(caller);
  return NextResponse.json({ results: await runAutopilotTick() });
});
