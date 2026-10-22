import { NextResponse } from 'next/server';
import { requireProjectPermission, type Caller } from '@/server/auth';
import { withAuth, jsonBody } from '@/server/route';
import { archivePreviousBatch } from '@/modules/reddit/store';

// POST /api/projects/:projectId/reddit/items/archive
//
// Called once per Analyse run, after its first post is scored: everything
// analysed before this run moves to the Archived tab, so Brand and Growth show
// only the fresh batch. The client names the run's own posts in exceptItemIds;
// favourites and posts with an unposted draft are kept server-side regardless.
//
// Gated on items.analyze — it is part of the Analyse run, and it only ever
// changes processingStatus, which the same permission can already do per post.

interface Body {
  exceptItemIds?: unknown;
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];

type Ctx = { params: Promise<{ projectId: string }> };

export const POST = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'items.analyze');

  const body = await jsonBody<Body>(req);
  const result = await archivePreviousBatch(projectId, strings(body.exceptItemIds));

  return NextResponse.json(result);
});
