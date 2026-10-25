import 'server-only';

import { DescribeInstancesCommand, EC2Client, StartInstancesCommand } from '@aws-sdk/client-ec2';
import { FieldValue } from 'firebase-admin/firestore';
import { adminDb } from './admin';
import { ONLINE_WINDOW_MS } from '@/lib/agentStatus';

// Waking the posting agent's cloud server.
//
// The server sleeps when it has had nothing to do for a while (the agent shuts
// Windows down, which on AWS stops the instance and its bill). Engage starts it
// again whenever there is work: right after a task is queued, from the "Wake"
// button, and from the every-5-minutes check for tasks that were scheduled for
// later (/api/agent/wake-check).
//
// The AWS key here can do exactly one thing — start this one instance — so even
// leaked it cannot touch anything else. Without the env vars this is a no-op,
// which is what a setup with the agent on a laptop wants.
//
//   AGENT_WAKE_INSTANCE_ID, AGENT_WAKE_REGION,
//   AGENT_WAKE_ACCESS_KEY_ID, AGENT_WAKE_SECRET_ACCESS_KEY
//
// (Not AWS_*: Vercel reserves those names.)

export type WakeOutcome = 'online' | 'started' | 'already-starting' | 'stopping' | 'not-configured' | 'error';

function config() {
  const instanceId = process.env.AGENT_WAKE_INSTANCE_ID;
  const region = process.env.AGENT_WAKE_REGION;
  const accessKeyId = process.env.AGENT_WAKE_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AGENT_WAKE_SECRET_ACCESS_KEY;
  if (!instanceId || !region || !accessKeyId || !secretAccessKey) return null;
  return { instanceId, client: new EC2Client({ region, credentials: { accessKeyId, secretAccessKey } }) };
}

/**
 * Read the server's real state from AWS and record it on agents/agent, so the
 * status chip can say "asleep" whenever the server is off — however it got
 * there — instead of a red "offline". Without it, only a sleep the agent itself
 * started was marked, and a Windows shutdown from anything else read as a fault.
 *
 * Needs ec2:DescribeInstances on the wake key. Without that (or any other
 * failure) it records nothing and returns null: the chip falls back to the
 * agent's own "asleep" mark, as before.
 */
export async function recordServerState(): Promise<string | null> {
  const cfg = config();
  if (!cfg) return null;
  try {
    const res = await cfg.client.send(new DescribeInstancesCommand({ InstanceIds: [cfg.instanceId] }));
    const state = res.Reservations?.[0]?.Instances?.[0]?.State?.Name ?? null;
    if (!state) return null;
    await adminDb()
      .collection('agents')
      .doc('agent')
      .set({ serverState: state, serverStateAt: FieldValue.serverTimestamp() }, { merge: true });
    return state;
  } catch (e) {
    console.error('recordServerState failed:', (e as Error)?.message);
    return null;
  }
}

/** Is the agent's heartbeat fresh? Then there is nothing to wake. */
async function agentOnline(): Promise<boolean> {
  const snap = await adminDb().collection('agents').doc('agent').get();
  const seen = snap.get('lastSeenAt');
  const ms = seen && typeof seen.toMillis === 'function' ? seen.toMillis() : 0;
  return ms > 0 && Date.now() - ms < ONLINE_WINDOW_MS;
}

/**
 * Start the agent's server if it is asleep. Never throws: a task is already
 * safely queued by the time this runs, and the every-5-minutes check retries
 * anything this misses — most often a server caught mid-shutdown, which AWS
 * cannot start until it has fully stopped.
 */
export async function wakeAgent(reason: string): Promise<WakeOutcome> {
  const cfg = config();
  if (!cfg) return 'not-configured';
  try {
    if (await agentOnline()) return 'online';
    const res = await cfg.client.send(new StartInstancesCommand({ InstanceIds: [cfg.instanceId] }));
    const previous = res.StartingInstances?.[0]?.PreviousState?.Name;
    if (previous === 'stopped') {
      await adminDb()
        .collection('agents')
        .doc('agent')
        .set({ wakeRequestedAt: FieldValue.serverTimestamp(), wakeReason: reason.slice(0, 80) }, { merge: true });
      return 'started';
    }
    return 'already-starting';
  } catch (e) {
    const name = (e as { name?: string })?.name;
    if (name === 'IncorrectInstanceState') return 'stopping';
    console.error('wakeAgent failed:', (e as Error)?.message);
    return 'error';
  }
}
