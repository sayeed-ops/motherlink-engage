import { NextResponse } from 'next/server';
import { withAuth, jsonBody } from '@/server/route';
import { requireProjectPermission, type Caller } from '@/server/auth';
import { getShopifyConfig, saveShopifyConfig } from '@/server/shopify';
import { fetchCategories, ShopifyReadError } from '@/modules/shopify/reader';
import { DEFAULT_CATEGORIES, SORT_HELP, SORT_LABEL, SORTS } from '@/modules/shopify/categories';
import { MAX_PAGES_PER_CATEGORY, MAX_QUIET_DAYS } from '@/modules/shopify/config';

// GET /api/projects/:projectId/shopify  — settings, plus every board on offer
// PUT /api/projects/:projectId/shopify  — replace the settings
//
// Reading is `project.view`; changing is `project.settings`. Which boards a
// project reads is a spending decision (a request per page per board) rather
// than a preference, and the screen limits decide what a run can ever see.

type Ctx = { params: Promise<{ projectId: string }> };

export const GET = withAuth<Ctx>(async (_req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'project.view');

  // ⚠️ THE CATALOGUE IS FETCHED LIVE, AND A FAILURE HERE IS NOT FATAL.
  //
  // The operator may select any of the forty boards the community publishes, so
  // a hardcoded list would silently omit whatever Shopify added last month.
  // But the settings screen must still open when the community is unreachable
  // or rate-limiting us — otherwise a 429 from somebody else's server locks
  // this project out of its own configuration. On failure the shipped six
  // travel instead, with the reason stated rather than an empty picker.
  let catalogue = DEFAULT_CATEGORIES.map((c) => ({ ...c }));
  let catalogueError: string | null = null;
  try {
    const live = await fetchCategories();
    if (live.length) catalogue = live;
  } catch (err) {
    catalogueError =
      err instanceof ShopifyReadError
        ? `The board list could not be read: ${err.message}`
        : 'The board list could not be read.';
  }

  return NextResponse.json({
    config: await getShopifyConfig(projectId),
    catalogue,
    catalogueError,
    sorts: SORTS.map((s) => ({ id: s, label: SORT_LABEL[s], help: SORT_HELP[s] })),
    limits: { pagesPerCategory: MAX_PAGES_PER_CATEGORY, quietAfterDays: MAX_QUIET_DAYS },
  });
});

export const PUT = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'project.settings');

  const body = await jsonBody<{ config?: unknown }>(req);
  // Normalisation is server-side, and what comes back is what was stored — a
  // screen rendering the values it SENT rather than the values that were KEPT
  // is how a silently dropped board goes unnoticed.
  return NextResponse.json({ config: await saveShopifyConfig(projectId, body.config, caller.uid) });
});
