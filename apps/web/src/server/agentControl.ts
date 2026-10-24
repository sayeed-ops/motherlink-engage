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

/** The model that designs warm-up plans.
 *
 *  Platform-wide rather than per-project because warm-up is ACCOUNT-scoped —
 *  a Reddit identity does not belong to one client — so there is no project
 *  config to hang it on. It lives here beside dryRun because agents/control is
 *  already the home for platform switches: server-write-only, readable by any
 *  signed-in user, no new collection or rule.
 *
 *  null means the platform default, exactly as for the per-project settings. */
export async function setWarmupModel(modelRef: string | null, uid: string, byName: string): Promise<void> {
  await controlRef().set(
    {
      warmupModel: modelRef,
      updatedBy: uid,
      updatedByName: byName,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

export async function getWarmupModel(): Promise<string | null> {
  const snap = await controlRef().get();
  const v = snap.exists ? (snap.data() as { warmupModel?: unknown }).warmupModel : null;
  return typeof v === 'string' && v ? v : null;
}

/** Minutes the cloud server may sit with nothing to do before it shuts down
 *  (0 = never). The agent reads it every poll; absent means 5. */
export async function setIdleSleepMinutes(minutes: number, uid: string, byName: string): Promise<void> {
  await controlRef().set(
    {
      idleSleepMinutes: minutes,
      updatedBy: uid,
      updatedByName: byName,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

/** Keep the cloud server up until this time (ms), whatever the idle setting —
 *  set by Wake now / Keep awake so it is still on when someone connects. */
export async function setAwakeUntil(awakeUntilMs: number, uid: string, byName: string): Promise<void> {
  await controlRef().set(
    {
      awakeUntilMs,
      updatedBy: uid,
      updatedByName: byName,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

/**
 * Flip dry run for one platform.
 *
 * Reddit keeps its original top-level `dryRun`, which older agents read. Any
 * other platform lives under `dryRunByPlatform.<platform>`, and the agent treats
 * anything but an explicit `false` there as dry run — so a new platform can never
 * inherit Reddit being live.
 */
export async function setDryRun(dryRun: boolean, uid: string, byName: string, platform: 'reddit' | 'shopify' = 'reddit'): Promise<void> {
  await controlRef().set(
    {
      ...(platform === 'reddit' ? { dryRun } : { dryRunByPlatform: { [platform]: dryRun } }),
      updatedBy: uid,
      updatedByName: byName,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}
