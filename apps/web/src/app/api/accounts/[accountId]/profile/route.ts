import { NextResponse } from 'next/server';
import { requirePlatformAdmin, type Caller } from '@/server/auth';
import { withAuth, jsonBody, badRequest } from '@/server/route';
import { getAccount } from '@/server/accounts';
import { canStoreComment, openAccountComment, queueCreateProfile, readProfileRequest, saveAccountComment } from '@/server/profileTasks';
import { parseProxy } from '@/modules/accounts/proxy';

// POST /api/accounts/[accountId]/profile — create an AdsPower profile for an
// account that has none: a retry after a failed creation, or an older account.
// Refused when the account already has a profile, so it can never orphan one.
// A comment sent here replaces the stored one; none sent keeps it.

type Ctx = { params: Promise<{ accountId: string }> };

export const POST = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  requirePlatformAdmin(caller);
  const { accountId } = await ctx.params;
  const account = await getAccount(accountId);
  if (!account) return badRequest('No such account.');
  if (String(account.adsPowerProfileId ?? '').trim()) return badRequest('This account already has an AdsPower profile.');
  const prov = account.provisioning as { state?: string } | undefined;
  if (prov?.state === 'creating') return badRequest('A profile is already being created for this account.');

  const body = await jsonBody<{ profile?: unknown; comment?: unknown }>(req);
  const sent = typeof body.comment === 'string';
  if (sent && String(body.comment).trim() && !canStoreComment()) return badRequest('Encryption is not configured, so the comment cannot be stored.');
  const comment = sent ? String(body.comment) : await openAccountComment(accountId).catch(() => '');

  const profile = readProfileRequest({ ...(body.profile as object), comment }, String(account.label ?? ''), parseProxy);
  if (typeof profile === 'string') return badRequest(profile);
  if (sent) await saveAccountComment(accountId, comment);
  const taskId = await queueCreateProfile(accountId, profile.spec, profile.proxy, caller.uid);
  return NextResponse.json({ accountId, taskId }, { status: 202 });
});
