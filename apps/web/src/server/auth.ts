import 'server-only';

import { adminAuth, adminDb } from './admin';
import type { GlobalPermission, GlobalRole, Permission, UserProfile } from '@/lib/types';

// Caller identity and authorization.
//
// Every route handler that does anything begins here. ML Studio's four Reddit
// routes and its invitation relay perform NO auth check of any kind — they are
// callable by anyone on the internet. (Verified: an anonymous POST to
// production's fetch-posts returns a normal application response, not a 401.)
// Nothing in this file has an equivalent over there.

/** Thrown for any authz failure. Carries the HTTP status the route should return. */
export class AuthError extends Error {
  constructor(
    readonly status: 401 | 403,
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export interface Caller {
  uid: string;
  email: string;
  role: GlobalRole;
  profile: UserProfile;
}

// Short-TTL caches, keyed within a single server instance.
//
// Every request used to make a network call to Google (verifyIdToken with
// checkRevoked) plus a Firestore read for the profile plus a read for project
// membership — ~1.4s of overhead before any real work. These caches remove the
// two Firestore reads on hot paths.
//
// The tradeoff is staleness: a revoked user or a changed permission lags by up
// to CACHE_TTL_MS. That is acceptable here because it is bounded and short, and
// because the security-critical revocation path (disabling a user) ALSO
// disables the Firebase Auth user and revokes their refresh tokens — so their
// token stops verifying regardless of this cache. The cache can only delay a
// *permission* change, never resurrect a disabled account beyond one token's
// remaining life.
const CACHE_TTL_MS = 30_000;

interface Cached<T> {
  value: T;
  at: number;
}

const profileCache = new Map<string, Cached<UserProfile>>();
const membershipCache = new Map<string, Cached<Permission[] | null>>();

function cacheGet<T>(map: Map<string, Cached<T>>, key: string, now: number): T | undefined {
  const hit = map.get(key);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.value;
  return undefined;
}

/** Drop a user's cached profile and all their cached memberships. Call after a
 *  write that changes their access, so it takes effect immediately rather than
 *  after the TTL. */
export function invalidateCaller(uid: string): void {
  profileCache.delete(uid);
  for (const key of membershipCache.keys()) {
    if (key.endsWith(`:${uid}`)) membershipCache.delete(key);
  }
}

/**
 * Verify the bearer token and load the caller's profile.
 *
 * Two distinct failures, deliberately not collapsed:
 *   401 — we don't know who you are.
 *   403 — we know, and you are not provisioned (or you're disabled).
 *
 * The 403 matters now that Google sign-in is enabled: anyone with a Google
 * account can AUTHENTICATE. Authorization is a separate question, answered
 * here by whether an admin created a users/{uid} document for them. A stray
 * sign-in gets a clean "not provisioned" rather than an empty dashboard.
 */
export async function requireCaller(req: Request): Promise<Caller> {
  const header = req.headers.get('authorization') ?? '';
  const match = /^Bearer (.+)$/i.exec(header.trim());
  if (!match) {
    throw new AuthError(401, 'Missing bearer token.');
  }

  let decoded;
  try {
    // checkRevoked is deliberately FALSE. It was costing a ~250ms round-trip to
    // Google on every request, and it is redundant: disabling a user (the only
    // way to revoke) also sets the Auth user to disabled and revokes refresh
    // tokens, and we re-check `status === 'disabled'` on the profile below. So
    // a disabled user is blocked here even though we skip the network check.
    // The only thing checkRevoked would add is killing a token within seconds
    // of a manual token revocation with no status change — a case we don't have.
    decoded = await adminAuth().verifyIdToken(match[1], false);
  } catch {
    throw new AuthError(401, 'Invalid or expired token.');
  }

  const now = Date.now();
  let profile = cacheGet(profileCache, decoded.uid, now);
  if (!profile) {
    const snap = await adminDb().collection('users').doc(decoded.uid).get();
    if (!snap.exists) {
      throw new AuthError(403, 'Your account is not provisioned. Ask an administrator for access.');
    }
    profile = snap.data() as UserProfile;
    profileCache.set(decoded.uid, { value: profile, at: now });
  }

  if (profile.status === 'disabled') {
    throw new AuthError(403, 'Your account has been disabled.');
  }

  return {
    uid: decoded.uid,
    email: profile.email,
    role: profile.role,
    profile,
  };
}

export function isPlatformAdmin(caller: Caller): boolean {
  return caller.role === 'owner' || caller.role === 'admin';
}

export function requirePlatformAdmin(caller: Caller): void {
  if (!isPlatformAdmin(caller)) {
    throw new AuthError(403, 'This action requires an administrator.');
  }
}

export function requireGlobalPermission(caller: Caller, permission: GlobalPermission): void {
  if (isPlatformAdmin(caller)) return;
  if (!caller.profile.globalPermissions?.includes(permission)) {
    throw new AuthError(403, `This action requires the "${permission}" permission.`);
  }
}

/**
 * Load a caller's permissions on one project.
 *
 * Platform admins get everything implicitly. Everyone else must have a member
 * document — its absence is indistinguishable from the project not existing,
 * which is intentional: a non-member should not be able to probe for which
 * client projects exist.
 */
export async function projectPermissions(caller: Caller, projectId: string): Promise<Permission[] | null> {
  if (isPlatformAdmin(caller)) {
    const { PERMISSIONS } = await import('@/lib/types');
    return [...PERMISSIONS];
  }

  const now = Date.now();
  const key = `${projectId}:${caller.uid}`;
  const cached = cacheGet(membershipCache, key, now);
  if (cached !== undefined) return cached;

  const snap = await adminDb()
    .collection('projects')
    .doc(projectId)
    .collection('members')
    .doc(caller.uid)
    .get();

  const permissions = snap.exists ? ((snap.data()?.permissions ?? []) as Permission[]) : null;
  membershipCache.set(key, { value: permissions, at: now });
  return permissions;
}

/**
 * The main gate. Throws unless the caller holds `permission` on `projectId`.
 *
 * Note both failures are 403 with the same shape — "not a member" and "member
 * without this permission" must not be distinguishable to a caller probing for
 * project IDs.
 */
export async function requireProjectPermission(
  caller: Caller,
  projectId: string,
  permission: Permission,
): Promise<Permission[]> {
  const held = await projectPermissions(caller, projectId);
  if (!held) {
    throw new AuthError(403, 'Project not found, or you do not have access to it.');
  }
  if (!held.includes(permission)) {
    throw new AuthError(403, `This action requires the "${permission}" permission on this project.`);
  }
  return held;
}
