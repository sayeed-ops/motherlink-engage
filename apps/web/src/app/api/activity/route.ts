import { NextResponse } from 'next/server';
import { requireGlobalPermission, type Caller } from '@/server/auth';
import { withAuth } from '@/server/route';
import { listActivity } from '@/server/activityFeed';

// GET /api/activity?accountId=&days=30&before=<ms> — the account activity list
// (Accounts → Activity, and each account's Dashboard). See server/activityFeed.ts
// for what is in it and who sees what.

export const GET = withAuth(async (req: Request, caller: Caller) => {
  requireGlobalPermission(caller, 'accounts.manage');
  const url = new URL(req.url);
  const accountId = url.searchParams.get('accountId') || undefined;
  const days = Number(url.searchParams.get('days')) || 30;
  const before = Number(url.searchParams.get('before')) || undefined;
  return NextResponse.json(await listActivity(caller, { accountId, days, beforeMs: before }));
});
