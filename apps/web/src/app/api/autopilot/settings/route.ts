import { NextResponse } from 'next/server';
import { requirePlatformAdmin, type Caller } from '@/server/auth';
import { withAuth, jsonBody } from '@/server/route';
import { getAutopilotSettings, saveAutopilotSettings } from '@/server/autopilot';

// GET  /api/autopilot/settings — the warm-up autopilot's settings, for everyone.
// POST /api/autopilot/settings — change them (owner and admin). Every account on
// autopilot follows them from its next planned day.

export const GET = withAuth(async () => NextResponse.json(await getAutopilotSettings()));

export const POST = withAuth(async (req: Request, caller: Caller) => {
  requirePlatformAdmin(caller);
  const saved = await saveAutopilotSettings(await jsonBody<unknown>(req), caller.uid, caller.profile.displayName);
  return NextResponse.json(saved);
});
