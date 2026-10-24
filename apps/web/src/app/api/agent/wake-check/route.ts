import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { adminDb } from '@/server/admin';
import { wakeAgent } from '@/server/agentWake';

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
  if (!authorised(req)) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 });

  const nowMs = Date.now();
  const snap = await adminDb().collection('jobs').where('status', '==', 'queued').limit(50).get();
  const due = snap.docs.filter((d) => {
    const nb = Number(d.get('notBeforeMs'));
    return !(Number.isFinite(nb) && nb > nowMs + LEAD_MS);
  }).length;

  // Someone pressed Wake now while the server was mid-shutdown, which AWS
  // refuses: their keep-awake window is still open, so start it now.
  const control = await adminDb().collection('agents').doc('control').get();
  const keptAwake = Number(control.get('awakeUntilMs')) > nowMs;

  if (!due && !keptAwake) return NextResponse.json({ due: 0, outcome: 'nothing-due' });
  const outcome = await wakeAgent(due ? `timer: ${due} task(s) due` : 'timer: kept awake from Engage');
  return NextResponse.json({ due, keptAwake, outcome });
}
