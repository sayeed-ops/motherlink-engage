import { NextResponse } from 'next/server';
import { requireProjectPermission, type Caller } from '@/server/auth';
import { withAuth, jsonBody, badRequest } from '@/server/route';
import { purgeUnkeptItems } from '@/modules/reddit/store';

// POST /api/projects/:projectId/reddit/purge
//
// The scoped-retention purge that keeps the queue fresh, run once at the end of
// a fetch cycle. In ML Studio this fired automatically inside the fetch/search
// handler in the browser; here the client drives the cycle (one subreddit per
// request, for pacing and stop) and then asks the server to reconcile.
//
// Gated on items.fetch — it is part of the fetch cycle, and only ever removes
// stale fetched items. The retention rules (favourite, has-draft) are enforced
// server-side against Firestore, so the worst a caller can do with a bad body is
// clear its own non-favourited, un-answered history within the named subreddits
// — exactly what a normal purge does.

interface Body {
  keepItemIds?: unknown;
  onlySubreddits?: unknown;
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];

type Ctx = { params: Promise<{ projectId: string }> };

export const POST = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'items.fetch');

  const body = await jsonBody<Body>(req);
  const onlySubreddits = strings(body.onlySubreddits);
  const keepItemIds = strings(body.keepItemIds);

  // No scope means "delete across every subreddit", which is never what the
  // fetch cycle wants — a purge must always name the subreddits it just
  // refreshed, or an errored run could wipe the board.
  if (onlySubreddits.length === 0) return badRequest('onlySubreddits is required.');

  const result = await purgeUnkeptItems(projectId, keepItemIds, { onlySubreddits });

  return NextResponse.json(result);
});
