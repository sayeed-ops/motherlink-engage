'use client';

import {
  collection,
  collectionGroup,
  doc,
  onSnapshot,
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
};

export const path = {
  project: (projectId: string) => ['projects', projectId],
  redditConfig: (projectId: string) => ['projects', projectId, 'modules', 'reddit'],
};
