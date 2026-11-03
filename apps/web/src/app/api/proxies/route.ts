import { NextResponse } from 'next/server';
import { requireGlobalPermission, type Caller } from '@/server/auth';
import { withAuth, jsonBody, badRequest } from '@/server/route';
import { encryptionConfigured } from '@/server/crypto';
import { importPool, listPool } from '@/server/proxyPool';
import { parsePoolList } from '@/modules/accounts/proxyPool';

// GET  /api/proxies — the proxy list, without passwords.
// POST /api/proxies — add a pasted list ({ text }), one proxy per line.
//
// accounts.manage, like the accounts themselves: these are their identities.

export const GET = withAuth(async (_req: Request, caller: Caller) => {
  requireGlobalPermission(caller, 'accounts.manage');
  return NextResponse.json({ entries: await listPool() });
});

export const POST = withAuth(async (req: Request, caller: Caller) => {
  requireGlobalPermission(caller, 'accounts.manage');
  if (!encryptionConfigured()) return badRequest('Encryption is not configured, so proxy passwords cannot be stored.');
  const { text } = await jsonBody<{ text?: string }>(req);
  const { proxies, errors } = parsePoolList(String(text ?? ''));
  if (!proxies.length) return badRequest(errors.length ? `Line ${errors[0].line}: ${errors[0].error}` : 'Paste at least one proxy.');
  const result = await importPool(proxies);
  return NextResponse.json({ ...result, errors });
});
