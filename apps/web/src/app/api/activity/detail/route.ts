import { NextResponse } from 'next/server';
import { requireGlobalPermission, type Caller } from '@/server/auth';
import { withAuth, badRequest } from '@/server/route';
import { activityDetail } from '@/server/activityFeed';

// GET /api/activity/detail?key=job:<id> | scan:<accountId>:<draftId> — the steps
// of one row, fetched when it is opened rather than for every row in the list.

export const GET = withAuth(async (req: Request, caller: Caller) => {
  requireGlobalPermission(caller, 'accounts.manage');
  const key = new URL(req.url).searchParams.get('key') ?? '';
  if (!/^(job:[\w-]+|scan:[\w-]+:[\w-]+)$/.test(key)) return badRequest('Bad key.');
  const detail = await activityDetail(caller, key);
  if (!detail) return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  return NextResponse.json(detail);
});
