import { NextResponse } from 'next/server';
import { withAuth, jsonBody, badRequest } from '@/server/route';
import { requirePlatformAdmin, type Caller } from '@/server/auth';
import { adminDb } from '@/server/admin';
import { writeActivityLog } from '@/server/activityLog';
import { getCredential, maskCredential, setGrants } from '@/server/llm/credentials';
import { invalidateLlmCache } from '@/server/llm/resolve';

type Ctx = { params: Promise<{ credentialId: string }> };

// Which projects may spend this shared key.
//
// The whole array is replaced on every call — grants are a set, and a
// set-the-whole-thing PUT cannot half-apply the way an add/remove pair can.
// Revocation is therefore atomic: one write, no fan-out to miss.

interface GrantsBody {
  grantedProjectIds?: unknown;
  grantAllProjects?: unknown;
}

export const PUT = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  requirePlatformAdmin(caller);
  const { credentialId } = await ctx.params;

  const cred = await getCredential(credentialId);
  if (!cred) return badRequest('No such credential.');
  if (cred.scope !== 'shared') {
    // A personal key belongs to one person and is never granted out; letting
    // this through would make someone's own key silently spendable by a project.
    return badRequest('Only a shared key can be granted to projects.');
  }

  const body = await jsonBody<GrantsBody>(req);
  const grantAllProjects = body.grantAllProjects === true;
  const rawIds = Array.isArray(body.grantedProjectIds) ? body.grantedProjectIds : [];
  const requested = [...new Set(rawIds.filter((v): v is string => typeof v === 'string' && v.trim().length > 0))];

  // Validate every id against real projects. Without this a typo silently
  // becomes a grant to nothing, and the admin sees a saved state that will
  // never resolve at run time.
  let grantedProjectIds: string[] = [];
  if (requested.length) {
    const docs = await adminDb().getAll(...requested.map((id) => adminDb().collection('projects').doc(id)));
    const missing = requested.filter((_, i) => !docs[i].exists);
    if (missing.length) return badRequest(`No such project: ${missing.join(', ')}.`);
    grantedProjectIds = requested;
  }

  await setGrants(credentialId, grantedProjectIds, grantAllProjects);

  await writeActivityLog({
    caller,
    action: 'llm.grants_changed',
    targetType: 'llmCredential',
    targetId: credentialId,
    targetName: cred.label,
    // Counts and ids only — never the key or its hint.
    metadata: { provider: cred.provider, grantAllProjects, projectCount: grantedProjectIds.length, grantedProjectIds },
  });

  // A grant change can affect anyone, so clear the whole cache rather than one
  // user's entry.
  invalidateLlmCache();

  const fresh = await getCredential(credentialId);
  return NextResponse.json({ credential: fresh ? maskCredential(fresh) : null });
});
