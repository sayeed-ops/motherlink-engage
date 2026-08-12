import { NextResponse } from 'next/server';
import { withAuth, badRequest } from '@/server/route';
import { isPlatformAdmin, type Caller } from '@/server/auth';
import { getCredential, deleteCredential } from '@/server/llm/credentials';
import { writeActivityLog } from '@/server/activityLog';
import { invalidateLlmCache } from '@/server/llm/resolve';

type Ctx = { params: Promise<{ credentialId: string }> };

// Delete one credential.
//
// A personal key is deletable by its owner or by a platform admin (someone has
// to be able to clear a key belonging to a departed user). Ownership is checked
// against the stored document, never against anything the client sent.

export const DELETE = withAuth<Ctx>(async (_req: Request, caller: Caller, ctx: Ctx) => {
  const { credentialId } = await ctx.params;

  const cred = await getCredential(credentialId);
  if (!cred) return badRequest('No such credential.');

  const owns = cred.scope === 'personal' && cred.ownerUid === caller.uid;
  if (!owns && !isPlatformAdmin(caller)) {
    // Same 403 shape as a missing permission — do not confirm the credential
    // exists to someone who has no business with it.
    return NextResponse.json({ error: 'You cannot remove that credential.' }, { status: 403 });
  }

  await deleteCredential(credentialId);

  if (cred.scope === 'shared') {
    // Removing a shared key can break analysis for every project it was granted
    // to, so it is worth an audit row — and worth knowing who did it.
    await writeActivityLog({
      caller,
      action: 'llm.credential_deleted',
      targetType: 'llmCredential',
      targetId: credentialId,
      targetName: cred.label,
      metadata: {
        provider: cred.provider,
        grantAllProjects: cred.grantAllProjects ?? false,
        projectCount: (cred.grantedProjectIds ?? []).length,
      },
      severity: 'warning',
    });
  }

  if (cred.ownerUid) invalidateLlmCache(cred.ownerUid);
  else invalidateLlmCache();

  return NextResponse.json({ ok: true });
});
