import { NextResponse } from 'next/server';
import { withAuth, jsonBody, badRequest } from '@/server/route';
import { requireProjectPermission, type Caller } from '@/server/auth';
import { listTopics, setSelected, TOPIC_LIMIT_CEILING } from '@/server/shopify';

// GET   /api/projects/:projectId/shopify/topics — the stored listing
// PATCH /api/projects/:projectId/shopify/topics — tick or untick rows
//
// Ticking a row costs nothing and commits to nothing; it marks what a person
// wants opened when they run stage two. So it is `project.view` to read and
// `items.fetch` to change — the same tier as the reading it queues up, not the
// model-spend tier, because selecting is not spending.

type Ctx = { params: Promise<{ projectId: string }> };

export const GET = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'project.view');

  const url = new URL(req.url);
  const categoryId = Number(url.searchParams.get('categoryId'));

  return NextResponse.json({
    topics: await listTopics(projectId, {
      categoryId: Number.isInteger(categoryId) && categoryId > 0 ? categoryId : undefined,
      worthReadingOnly: url.searchParams.get('worthReading') === '1',
      selectedOnly: url.searchParams.get('selected') === '1',
      limit: Number(url.searchParams.get('limit')) || undefined,
    }),
  });
});

interface PatchBody {
  topicIds?: unknown;
  selected?: unknown;
}

export const PATCH = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'items.fetch');

  const body = await jsonBody<PatchBody>(req);
  if (typeof body.selected !== 'boolean') {
    return badRequest('`selected` must be true or false.');
  }

  const ids = Array.isArray(body.topicIds)
    ? body.topicIds.map(Number).filter((n) => Number.isInteger(n) && n > 0)
    : [];
  if (!ids.length) return badRequest('At least one topic id is required.');
  // A tick-all over a wide board should not become an unbounded write.
  if (ids.length > TOPIC_LIMIT_CEILING) {
    return badRequest(`That is ${ids.length} topics; ${TOPIC_LIMIT_CEILING} is the most in one go.`);
  }

  // The count comes from the write, not from what the caller sent — a row that
  // was already ticked, or that we have never seen, is not a change, and
  // reporting the request's length would overstate what happened.
  const changed = await setSelected(projectId, ids, body.selected);
  return NextResponse.json({ changed, selected: body.selected });
});
