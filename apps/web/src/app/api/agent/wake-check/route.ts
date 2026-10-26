import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { adminDb } from '@/server/admin';
import { recordServerState, wakeAgent } from '@/server/agentWake';
import { runAutopilotTick } from '@/server/autopilot';

// POST /api/agent/wake-check — called every 5 minutes by an AWS EventBridge
// schedule (Vercel's free plan only runs crons daily).
//
// Queueing a task wakes the server straight away, but two kinds of work have no
// such moment: a task scheduled for later (a retry, a planned session), and one
// queued while the server was shutting down, which AWS cannot start until it has
// fully stopped. This catches both: anything queued and due within the next few
// minutes wakes it — as does an open Wake now / Keep awake window.
//
// Not a signed-in route — the schedule has no user. It carries
// AGENT_WAKE_CHECK_SECRET in the x-wake-secret header instead.

// The autopilot may run one comment scan in here (see runDueComments).
export const maxDuration = 60;

const LEAD_MS = 6 * 60_000; // about a boot's worth, so a scheduled task starts on time

function authorised(req: Request): boolean {
  const want = process.env.AGENT_WAKE_CHECK_SECRET;
  const got = req.headers.get('x-wake-secret');
  if (!want || !got) return false;
  const a = Buffer.from(want);
  const b = Buffer.from(got);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: Request) {
  // 403, never 401: EventBridge marks its connection DEAUTHORIZED on a 401 and
  // stops calling for good — which is what happened when the first calls came
  // in before Vercel had the secret (2026-10-24). A 403 is just a failed call.
  if (!authorised(req)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  // Every check also records what AWS says the server is doing, for the chip.
  const serverState = await recordServerState();

  // The warm-up autopilot plans each account's day here, once a day per account
  // (it returns at once when nothing is due). Its sessions are queued with start
  // times, which the check below then counts like any other scheduled job.
  // Never allowed to stop the wake itself.
  const planned = await runAutopilotTick().catch((e) => {
    console.error('autopilot tick failed:', (e as Error)?.message);
    return [];
  });
  const autopilot = planned.filter((r) => r.outcome !== 'not-due').length;

  const nowMs = Date.now();
  // 200, like the agent: the autopilot queues whole days ahead (unordered read).
  const snap = await adminDb().collection('jobs').where('status', '==', 'queued').limit(200).get();
  const jobsDue = snap.docs.filter((d) => {
    const nb = Number(d.get('notBeforeMs'));
    return !(Number.isFinite(nb) && nb > nowMs + LEAD_MS);
  }).length;
  // Proxy tests and new profiles from the account form wait in their own queue.
  const tasks = await adminDb().collection('profileTasks').where('status', '==', 'queued').limit(1).get();
  const due = jobsDue + tasks.size;

  // Someone pressed Wake now while the server was mid-shutdown, which AWS
  // refuses: their keep-awake window is still open, so start it now.
  const control = await adminDb().collection('agents').doc('control').get();
  const keptAwake = Number(control.get('awakeUntilMs')) > nowMs;

  if (!due && !keptAwake) return NextResponse.json({ due: 0, serverState, autopilot, outcome: 'nothing-due' });
  const outcome = await wakeAgent(due ? `timer: ${due} task(s) due` : 'timer: kept awake from Engage');
  return NextResponse.json({ due, keptAwake, serverState, autopilot, outcome });
}
