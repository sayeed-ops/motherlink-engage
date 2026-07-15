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
    // checkRevoked: a disabled or signed-out user's token stops working
    // immediately rather than lingering until it expires.
    decoded = await adminAuth().verifyIdToken(match[1], true);
  } catch {
    throw new AuthError(401, 'Invalid or expired token.');
  }

  const snap = await adminDb().collection('users').doc(decoded.uid).get();
  if (!snap.exists) {
    throw new AuthError(403, 'Your account is not provisioned. Ask an administrator for access.');
  }

  const profile = snap.data() as UserProfile;
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

  const snap = await adminDb()
    .collection('projects')
    .doc(projectId)
    .collection('members')
    .doc(caller.uid)
    .get();

  if (!snap.exists) return null;
  return (snap.data()?.permissions ?? []) as Permission[];
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
