import { NextResponse } from 'next/server';
import { requirePlatformAdmin, type Caller } from '@/server/auth';
import { withAuth, jsonBody, badRequest } from '@/server/route';
import { createAccount, type AccountInput } from '@/server/accounts';
import { canStoreComment, queueCreateProfile, readProfileRequest, saveAccountComment } from '@/server/profileTasks';
import { isAccountPlatform, cleanUsername } from '@/modules/accounts/platform';
import { parseProxy } from '@/modules/accounts/proxy';

// POST /api/accounts/provision — create the account AND its AdsPower profile in
// one go. The account is saved straight away with no profile id; the agent
// creates the profile on the server and links it (account.provisioning shows
// how it is going). The comment is stored encrypted and copied, word for word,
// into the profile's AdsPower remark.
//
// Owner and admin only (2026-10-25). Adding an account with an existing profile
// id stays on POST /api/accounts.

export const POST = withAuth(async (req: Request, caller: Caller) => {
  requirePlatformAdmin(caller);
  const body = await jsonBody<Partial<AccountInput> & { profile?: unknown; comment?: unknown }>(req);
  const label = body.label?.trim();
  if (!label) return badRequest('A label is required.');
  if (body.platform !== undefined && !isAccountPlatform(body.platform)) return badRequest('Unknown platform.');
  const platform = body.platform ?? 'reddit';
  if (platform === 'shopify' && !cleanUsername(body.username, 'shopify')) {
    return badRequest('A Shopify Community username is required — the agent checks it before posting.');
  }
  const comment = String(body.comment ?? '');
  if (comment.trim() && !canStoreComment()) return badRequest('Encryption is not configured, so the comment cannot be stored.');

  const profile = readProfileRequest({ ...(body.profile as object), comment }, label, parseProxy);
  if (typeof profile === 'string') return badRequest(profile);

  const accountId = await createAccount(
    {
      platform,
      label,
      username: body.username ?? '',
      adsPowerProfileId: '',
      status: body.status ?? 'warming',
      dailyCap: body.dailyCap ?? 5,
      minIntervalMinutes: body.minIntervalMinutes ?? 45,
      karma: body.karma ?? 0,
      notes: body.notes ?? '',
    },
    caller.uid,
    caller.profile.displayName,
  );
  if (comment.trim()) await saveAccountComment(accountId, comment);
  const taskId = await queueCreateProfile(accountId, profile.spec, profile.proxy, caller.uid);

  return NextResponse.json({ accountId, taskId }, { status: 201 });
});
