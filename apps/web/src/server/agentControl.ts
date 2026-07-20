import 'server-only';

import { FieldValue } from 'firebase-admin/firestore';
import { adminDb } from './admin';

// The local posting agent's live control surface (agents/control).
//
// The agent reads `dryRun` from here every poll, so flipping it from the web UI
// takes effect within one poll interval — no .env edit, no restart. This is the
// ONLY writer; the agent seeds the doc once (create-only) but never overwrites
// an operator's choice. Writing is gated on the global accounts.manage
// permission, same as the accounts it governs.

const controlRef = () => adminDb().collection('agents').doc('control');

export async function setDryRun(dryRun: boolean, uid: string, byName: string): Promise<void> {
  await controlRef().set(
    {
      dryRun,
      updatedBy: uid,
      updatedByName: byName,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}
