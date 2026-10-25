import { NextResponse } from 'next/server';
import { requireOwner, type Caller } from '@/server/auth';
import { withAuth } from '@/server/route';
import { wakeAgent } from '@/server/agentWake';
import { setAwakeUntil } from '@/server/agentControl';

// POST /api/agent/wake — start the agent's cloud server now, without queueing a
// task, and keep it up for KEEP_AWAKE_MS whatever the idle setting. For
// connecting to it: with a short idle time it would otherwise go back to sleep
// before anyone got in (once connected, it never sleeps). Pressed while the
// agent is online, it only extends the window. Owner only: it runs up the
// server bill. Queueing work still wakes the server for everyone.

const KEEP_AWAKE_MS = 30 * 60_000;

export const POST = withAuth(async (_req: Request, caller: Caller) => {
  requireOwner(caller);
  const awakeUntilMs = Date.now() + KEEP_AWAKE_MS;
  // Written before the wake, so the agent reads it on its very first poll.
  await setAwakeUntil(awakeUntilMs, caller.uid, caller.profile.displayName);
  const outcome = await wakeAgent(`button: ${caller.profile.displayName || caller.uid}`);
  return NextResponse.json({ outcome, awakeUntilMs });
});
