import { NextResponse } from 'next/server';
import { withAuth, jsonBody, badRequest } from '@/server/route';
import { requireProjectPermission, type Caller } from '@/server/auth';
import { addShopifySources, listShopifySources } from '@/server/shopifyKnowledge';
import { normaliseSource, parseSourcesJson, SourcesJsonError } from '@/modules/shopify/knowledge';

// GET  /api/projects/:projectId/shopify/knowledge — Shopify's own sources
// POST /api/projects/:projectId/shopify/knowledge — add one ({source}) or import ({json})
//
// `knowledge.manage` to write, as on Reddit: a source decides whether a reply
// may name the client at all, so it is policy rather than content.
//
// ⚠️ AN IMPORT SENDS THE PASTED TEXT, NOT PARSED ROWS. The server parses it with
// the same function the tests exercise, so what a browser sends is a paste and
// never a pre-shaped document.

type Ctx = { params: Promise<{ projectId: string }> };

export const GET = withAuth<Ctx>(async (_req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'project.view');
  return NextResponse.json({ sources: await listShopifySources(projectId) });
});

interface PostBody {
  source?: unknown;
  json?: unknown;
}

export const POST = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'knowledge.manage');

  const body = await jsonBody<PostBody>(req);

  if (typeof body.json === 'string') {
    let parsed;
    try {
      parsed = parseSourcesJson(body.json);
    } catch (err) {
      if (err instanceof SourcesJsonError) return badRequest(err.message);
      throw err;
    }
    if (!parsed.rows.length) {
      return badRequest(
        parsed.rejected.length
          ? `None of the ${parsed.rejected.length} rows were usable — each source needs at least a title.`
          : 'There were no sources in that JSON.',
      );
    }
    const res = await addShopifySources(projectId, parsed.rows, 'json', caller.uid);
    return NextResponse.json({ ...res, rejected: parsed.rejected }, { status: 201 });
  }

  const one = normaliseSource(body.source);
  if (!one.ok) return badRequest(`That source was not saved: ${one.reason}.`);
  const res = await addShopifySources(projectId, [one.source], 'manual', caller.uid);
  if (!res.created) return badRequest('A source with that URL or title is already held.');
  return NextResponse.json({ ...res, rejected: [] }, { status: 201 });
});
