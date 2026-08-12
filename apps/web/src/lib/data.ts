'use client';

import {
  collection,
  collectionGroup,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
  where,
  type DocumentData,
  type Query,
} from 'firebase/firestore';
import { db } from '@/lib/firebase/config';

// Client-side reads, straight from Firestore.
//
// This is the performance fix, and it is also how ML Studio's Reddit tool has
// always felt instant: the browser reads Firestore directly, backed by the SDK's
// local IndexedDB cache and live onSnapshot listeners. One hop, cached, and the
// UI updates in real time as the server writes.
//
// Engage went the other way at first — every read proxied browser -> our server
// -> Firestore, ~1.4s each, no cache. That bought nothing: security rules
// already scope reads to project membership (proven by the isolation tests), so
// the server was doing enforcement the rules do for free, slowly.
//
// The rule of thumb for the whole app:
//   READS  -> here, client SDK, subscribe().    Rules enforce access.
//   WRITES -> server route handlers.            allow write: if false.
//
// If a read ever needs to join across collections or hide fields a member may
// not see, it goes back to the server. Nothing so far does.

/** Subscribe to a live query. Returns an unsubscribe fn. Errors (usually a
 *  rules denial) are surfaced via onError so the UI can show them rather than
 *  hang on a spinner. */
export function subscribe<T = DocumentData>(
  q: Query,
  onData: (rows: T[]) => void,
  onError?: (err: Error) => void,
): () => void {
  return onSnapshot(
    q,
    (snap) => onData(snap.docs.map((d) => ({ id: d.id, ...d.data() }) as T)),
    (err) => onError?.(err),
  );
}

/** Subscribe to a single document. */
export function subscribeDoc<T = DocumentData>(
  path: string[],
  onData: (row: T | null) => void,
  onError?: (err: Error) => void,
): () => void {
  return onSnapshot(
    doc(db, path[0], ...path.slice(1)),
    (snap) => onData(snap.exists() ? ({ id: snap.id, ...snap.data() } as T) : null),
    (err) => onError?.(err),
  );
}

/** Live list of the current user's project ids, from a collection-group query
 *  on their membership docs. The project id is the members subcollection's
 *  grandparent — read from the ref path so member docs need not denormalise it. */
export function subscribeMyProjectIds(
  uid: string,
  onData: (projectIds: string[]) => void,
  onError?: (err: Error) => void,
): () => void {
  const q = query(collectionGroup(db, 'members'), where('uid', '==', uid));
  return onSnapshot(
    q,
    (snap) => {
      const ids = [...new Set(snap.docs.map((d) => d.ref.parent.parent?.id).filter((x): x is string => !!x))];
      onData(ids);
    },
    (err) => onError?.(err),
  );
}

// --- query builders, so components don't hand-assemble collection paths ---

const projectCol = (projectId: string, name: string) =>
  collection(db, 'projects', projectId, name);

export const q = {
  /** Projects the current user is a member of, via a collection-group query on
   *  members. Mirrors the server's list logic, but live and client-side. */
  myProjects: (uid: string): Query =>
    query(collectionGroup(db, 'members'), where('uid', '==', uid)),

  members: (projectId: string): Query => projectCol(projectId, 'members'),
  sources: (projectId: string): Query => projectCol(projectId, 'sources'),
  items: (projectId: string): Query => projectCol(projectId, 'items'),
  analyses: (projectId: string): Query => projectCol(projectId, 'analyses'),
  drafts: (projectId: string): Query => projectCol(projectId, 'drafts'),

  /** All activity, newest first — a platform admin may list the whole
   *  collection (the rule permits it regardless of the doc's userId). */
  activityLogs: (max = 200): Query =>
    query(collection(db, 'activity_logs'), orderBy('createdAt', 'desc'), limit(max)),

  /** A single user's own activity. The rule requires the userId filter for a
   *  non-admin, so this is the only activity query they may run. No orderBy:
   *  pairing it with the where would need a composite index, and a user's own
   *  log is small — sort client-side. */
  myActivityLogs: (uid: string, max = 200): Query =>
    query(collection(db, 'activity_logs'), where('userId', '==', uid), limit(max)),

  /** Posting identities. Top-level and global — any signed-in user may read
   *  them (they carry no secrets); writes are server-only. Sorted client-side. */
  accounts: (): Query => collection(db, 'accounts'),

  /** One account's Reddit-side stat history (karma/subscriptions over time),
   *  captured in-session by the agent. Newest first; drives the trend. */
  statSnapshots: (accountId: string, max = 60): Query =>
    query(collection(db, 'accounts', accountId, 'statSnapshots'), orderBy('capturedAtMs', 'desc'), limit(max)),

  /** One account's warm-up browsing sessions — the plan that was composed and
   *  the trace of what the agent actually managed. Newest first. Per-account
   *  rather than per-job because the useful question is "how have this account's
   *  sessions been going", which is history, not a single run. */
  warmupRuns: (accountId: string, max = 30): Query =>
    query(collection(db, 'accounts', accountId, 'warmupRuns'), orderBy('ranAt', 'desc'), limit(max)),

  /** This project's post-queue jobs, so drafts can show their live status
   *  (queued/posting/posted/failed). Top-level collection, filtered by project;
   *  the rule permits a member to read their own project's jobs. */
  jobs: (projectId: string): Query =>
    query(collection(db, 'jobs'), where('projectId', '==', projectId)),
};

/** The local posting agent's heartbeat doc (agents/agent). Absent/stale ⇒ the
 *  agent isn't running. */
export const agentStatusPath = ['agents', 'agent'];

/** The agent's live control doc (agents/control). `dryRun` is set from the UI and
 *  re-read by the agent every poll. Written server-side only (see /api/agent/dry-run). */
export const agentControlPath = ['agents', 'control'];

export const path = {
  project: (projectId: string) => ['projects', projectId],
  redditConfig: (projectId: string) => ['projects', projectId, 'modules', 'reddit'],
};
