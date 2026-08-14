import 'server-only';

import { FieldValue } from 'firebase-admin/firestore';
import { adminDb } from './admin';
import type { Caller } from './auth';

// Audit trail for consequential actions.
//
// Written server-side only (rules: `allow write: if false` on activity_logs),
// after the caller has been verified and authorised — so a log entry is proof
// an authorised action happened, not something a client can forge. ML Studio
// wrote these from the browser, where anyone could addDoc a fabricated entry.
//
// The doc shape mirrors ML Studio's so a future viewer (and the eventual log
// migration) reads both the same way. Reads are governed by the activity_logs
// rule: a platform admin sees all; everyone else sees only their own
// (resource.data.userId == auth.uid).
//
// This module only WRITES. The viewer UI is a separate piece of work; until it
// exists these accrue quietly and are readable via the Admin SDK / console.

export type LogSeverity = 'info' | 'warning' | 'error';

/** Actions worth an audit entry. Extended as more consequential ops land. */
export type LogAction =
  | 'project.history_cleaned'
  | 'project.deleted'
  | 'user.deleted'
  // A shared provider key is a spending instrument: whoever can reach it can
  // bill the org. Creating one, removing one, and changing which projects may
  // use it are all money decisions, so they get an audit row. The metadata
  // carries provider/label/project counts and NEVER the key or its hint.
  | 'llm.credential_created'
  | 'llm.credential_deleted'
  | 'llm.grants_changed'
  // The other half of the same money decision: which PEOPLE may spend a shared
  // key at all. A grant change and an entitlement change can each silently move
  // someone's work onto or off the org's bill, so both are audited.
  | 'user.shared_keys_granted'
  | 'user.shared_keys_revoked'
  | 'warmup.session_queued'
  | 'warmup.session_cancelled';

export interface LogEntry {
  caller: Caller;
  action: LogAction;
  targetType: string;
  targetId?: string;
  targetName?: string;
  // Any plain object of structured detail — the count summaries the callers
  // hand in are typed interfaces, which `object` accepts and Firestore stores.
  metadata?: object;
  severity?: LogSeverity;
}

/**
 * Record one audit entry. Best-effort: a logging failure must never fail the
 * action it was recording, so this swallows and reports its own errors.
 */
export async function writeActivityLog(entry: LogEntry): Promise<void> {
  try {
    await adminDb()
      .collection('activity_logs')
      .add({
        userId: entry.caller.uid,
        userEmail: entry.caller.email,
        userRole: entry.caller.role,
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId ?? null,
        targetName: entry.targetName ?? null,
        metadata: entry.metadata ?? {},
        severity: entry.severity ?? 'info',
        createdAt: FieldValue.serverTimestamp(),
      });
  } catch (err) {
    console.error('activity log write failed:', err);
  }
}
