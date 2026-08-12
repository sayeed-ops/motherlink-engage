import { NextResponse } from 'next/server';
import { withAuth, badRequest } from '@/server/route';
import { isPlatformAdmin, type Caller } from '@/server/auth';
import { decryptKey, getCredential, maskCredential, updateVerification } from '@/server/llm/credentials';
import { probeCredential } from '@/server/llm/probe';
import { invalidateLlmCache } from '@/server/llm/resolve';

type Ctx = { params: Promise<{ credentialId: string }> };

// Re-probe a stored key.
//
// Keys go stale in ways nothing tells us about: credit runs out, the key is
// revoked upstream, a provider adds or removes models. This is the "Re-check"
// button — and the same path a scheduled refresh would use later.
//
// A failed re-check marks the credential `invalid` rather than deleting it. The
// user pasted it for a reason; the fix is usually "top up the account", not
// "start over".

export const maxDuration = 30;

export const POST = withAuth<Ctx>(async (_req: Request, caller: Caller, ctx: Ctx) => {
  const { credentialId } = await ctx.params;

  const cred = await getCredential(credentialId);
  if (!cred) return badRequest('No such credential.');

  const owns = cred.scope === 'personal' && cred.ownerUid === caller.uid;
  if (!owns && !isPlatformAdmin(caller)) {
    return NextResponse.json({ error: 'You cannot re-check that credential.' }, { status: 403 });
  }

  // decryptKey's output goes straight into the probe's fetch and nowhere else.
  const probe = await probeCredential(cred.provider, decryptKey(cred));

  await updateVerification(credentialId, {
    allowedModels: probe.ok ? probe.allowedModels : cred.allowedModels ?? [],
    verification: probe.verification,
    lastError: probe.ok ? null : probe.error,
    status: probe.ok ? 'active' : 'invalid',
  });

  if (cred.ownerUid) invalidateLlmCache(cred.ownerUid);
  else invalidateLlmCache();

  const fresh = await getCredential(credentialId);
  return NextResponse.json({
    ok: probe.ok,
    error: probe.error,
    credential: fresh ? maskCredential(fresh) : null,
  });
});
