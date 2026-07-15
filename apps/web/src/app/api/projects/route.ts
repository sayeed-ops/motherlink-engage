import { NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { adminDb } from '@/server/admin';
import { requirePlatformAdmin, isPlatformAdmin, type Caller } from '@/server/auth';
import { withAuth, jsonBody, badRequest } from '@/server/route';
import { ENABLED_PLATFORMS, expandBundle, type Platform, type Project } from '@/lib/types';

// Projects — one per client.
//
// Compare with ML Studio, where the equivalent (`reddit_projects`) is created
// by the browser via addDoc() under a rule of `allow write: if isSignedIn()`.
// Any user could create, edit or delete any client's project, and there was no
// server involved to say otherwise. Here the client cannot write at all; it
// asks, and this handler decides.

/**
 * GET /api/projects — projects the caller can see.
 *
 * Platform admins see everything. Everyone else sees only projects they hold a
 * membership document for. A non-member cannot even learn that a project
 * exists, which is why this filters rather than returning 403s per project.
 */
export const GET = withAuth(async (_req: Request, caller: Caller) => {
  const db = adminDb();

  if (isPlatformAdmin(caller)) {
    const snap = await db.collection('projects').orderBy('createdAt', 'desc').get();
    return NextResponse.json({
      projects: snap.docs.map((d) => ({ projectId: d.id, ...d.data() })),
    });
  }

  // One collection-group query beats reading every project and filtering.
  const memberships = await db.collectionGroup('members').where('uid', '==', caller.uid).get();

  const projectIds = memberships.docs
    .map((d) => d.ref.parent.parent?.id)
    .filter((id): id is string => Boolean(id));

  if (projectIds.length === 0) {
    return NextResponse.json({ projects: [] });
  }

  const docs = await db.getAll(...projectIds.map((id) => db.collection('projects').doc(id)));

  return NextResponse.json({
    projects: docs
      .filter((d) => d.exists)
      .map((d) => ({ projectId: d.id, ...d.data() }))
      .sort((a, b) => String((b as Project).name).localeCompare(String((a as Project).name))),
  });
});

interface CreateBody {
  name?: string;
  clientWebsiteUrl?: string;
  enabledModules?: string[];
}

/**
 * POST /api/projects — create a client project.
 *
 * Platform admins only. The creator is added as a member with the full
 * `manager` bundle, otherwise an admin could create a project and then be
 * unable to see it as a normal user.
 */
export const POST = withAuth(async (req: Request, caller: Caller) => {
  requirePlatformAdmin(caller);

  const body = await jsonBody<CreateBody>(req);

  const name = body.name?.trim();
  if (!name) return badRequest('A project name is required.');

  const requested = body.enabledModules ?? ['reddit'];
  const invalid = requested.filter((m) => !ENABLED_PLATFORMS.includes(m as Platform));
  if (invalid.length) {
    // Guard against enabling a module that has no implementation behind it.
    return badRequest(
      `Not available yet: ${invalid.join(', ')}. Currently supported: ${ENABLED_PLATFORMS.join(', ')}.`,
    );
  }

  const db = adminDb();
  const ref = db.collection('projects').doc();
  const now = FieldValue.serverTimestamp();

  const batch = db.batch();

  batch.set(ref, {
    projectId: ref.id,
    name,
    clientWebsiteUrl: body.clientWebsiteUrl?.trim() ?? '',
    status: 'active',
    enabledModules: requested,
    createdBy: caller.uid,
    createdByName: caller.profile.displayName,
    createdAt: now,
    updatedAt: now,
  });

  batch.set(ref.collection('members').doc(caller.uid), {
    uid: caller.uid,
    email: caller.email,
    displayName: caller.profile.displayName,
    permissions: expandBundle('manager'),
    grantedFromBundle: 'manager',
    grantedBy: caller.uid,
    grantedAt: now,
  });

  await batch.commit();

  return NextResponse.json({ projectId: ref.id, name }, { status: 201 });
});
