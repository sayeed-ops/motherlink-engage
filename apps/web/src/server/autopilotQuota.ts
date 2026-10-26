import 'server-only';

import { FieldValue } from 'firebase-admin/firestore';
import { adminDb } from './admin';

// "A project reply used today's comment."
//
// Project work comes first. When a project reply is queued for an account, the
// autopilot's comments still waiting for that account today are cancelled —
// the planned slots that have not run, and any autopilot comment already on the
// queue but not yet started. The reply itself is never touched or delayed.
//
// Kept apart from server/autopilot.ts so the reply path (server/jobs.ts) can
// call it without importing the whole comment pipeline. Never throws: the
// reply is already queued, and this is the autopilot's bookkeeping.

const REASON = 'A project reply used today’s comment.';

export async function cancelAutopilotCommentsToday(accountId: string): Promise<void> {
  try {
    const ref = adminDb().collection('accounts').doc(accountId);
    await adminDb().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const comments = snap.get('autopilot.lastPlan.comments') as { status?: string }[] | undefined;
      if (!Array.isArray(comments) || !comments.some((c) => c.status === 'planned')) return;
      tx.update(ref, {
        'autopilot.lastPlan.comments': comments.map((c) => (c.status === 'planned' ? { ...c, status: 'cancelled', detail: REASON } : c)),
      });
    });
    const queued = await adminDb().collection('jobs').where('accountId', '==', accountId).where('status', '==', 'queued').get();
    for (const d of queued.docs) {
      if (d.get('kind') !== 'comment' || d.get('autopilot') !== true) continue;
      await d.ref.update({ status: 'cancelled', error: REASON, completedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    }
  } catch (e) {
    console.error('cancelAutopilotCommentsToday failed:', (e as Error)?.message);
  }
}
