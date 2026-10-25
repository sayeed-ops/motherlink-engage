import { NextResponse } from 'next/server';
import { requireOwner, type Caller } from '@/server/auth';
import { withAuth, jsonBody, badRequest } from '@/server/route';
import { setIdleSleepMinutes } from '@/server/agentControl';

// POST /api/agent/idle-sleep  { minutes: number }
//
// How long the cloud server waits with nothing to do before it shuts down to
// save money. 0 keeps it on. The agent re-reads it every poll, so it takes
// effect at once — no restart. Only the server sleeps (its .env opts in); a
// laptop running the agent ignores this. Owner only: it sets the server bill.

export const POST = withAuth(async (req: Request, caller: Caller) => {
  requireOwner(caller);
  const body = await jsonBody<{ minutes?: unknown }>(req);
  const minutes = Number(body.minutes);
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 240) {
    return badRequest('minutes must be a whole number from 0 (never sleep) to 240.');
  }
  await setIdleSleepMinutes(minutes, caller.uid, caller.profile.displayName);
  return NextResponse.json({ minutes });
});
