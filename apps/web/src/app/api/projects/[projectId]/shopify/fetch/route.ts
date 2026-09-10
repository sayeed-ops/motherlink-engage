import { NextResponse } from 'next/server';
import { withAuth, badRequest } from '@/server/route';
import { requireProjectPermission, type Caller } from '@/server/auth';
import { getShopifyConfig, saveTopics } from '@/server/shopify';
import { fetchTopics, ShopifyReadError } from '@/modules/shopify/reader';
import { screenTopic, type SkipReason } from '@/modules/shopify/topics';
import { estimateRequests } from '@/modules/shopify/config';

// POST /api/projects/:projectId/shopify/fetch — read the configured boards
//
// ════════════════════════════════════════════════════════════════════════════
// THIS SPENDS SOMEBODY ELSE'S SERVER AND NOTHING ELSE
//
// No model is called here and none will be. Stage one is the free half: a
// listing request per page per board, paced a second apart, and a screen made
// of arithmetic. `items.fetch` is the permission because the cost is requests
// against community.shopify.com — the model-spend tier (`items.analyze`) gates
// stage two, which is a separate route and a separate decision.
// ════════════════════════════════════════════════════════════════════════════

export const maxDuration = 300;

type Ctx = { params: Promise<{ projectId: string }> };

export const POST = withAuth<Ctx>(async (_req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'items.fetch');

  const config = await getShopifyConfig(projectId);
  if (!config.categories.length) {
    return badRequest('No boards are selected. Choose at least one in Settings.');
  }

  const nowMs = Date.now();
  const perCategory: {
    id: number;
    name: string;
    read: number;
    worthReading: number;
    pagesRead: number;
    truncated: boolean;
    error: string | null;
  }[] = [];

  const skipTally: Partial<Record<SkipReason, number>> = {};
  let created = 0;
  let updated = 0;
  let requests = 0;

  for (const category of config.categories) {
    try {
      const { topics, pagesRead, truncated } = await fetchTopics(category, config.sort, config.pagesPerCategory);
      requests += pagesRead;

      const saved = await saveTopics(projectId, topics, config.limits, nowMs);
      created += saved.created;
      updated += saved.updated;

      let worth = 0;
      for (const t of topics) {
        const { reasons } = screenTopic(t, nowMs, config.limits);
        if (!reasons.length) worth++;
        for (const r of reasons) skipTally[r] = (skipTally[r] ?? 0) + 1;
      }

      perCategory.push({
        id: category.id,
        name: category.name,
        read: topics.length,
        worthReading: worth,
        pagesRead,
        truncated,
        error: null,
      });
    } catch (err) {
      // ⚠️ ONE BOARD FAILING DOES NOT FAIL THE RUN. A 429 or a renamed board
      // must not discard the five boards already read and saved — the failure
      // is reported per board and the rest of the fetch continues. Covers took
      // the same posture on a thread that would not parse.
      perCategory.push({
        id: category.id,
        name: category.name,
        read: 0,
        worthReading: 0,
        pagesRead: 0,
        truncated: false,
        error: err instanceof ShopifyReadError ? err.message : 'That board could not be read.',
      });
    }
  }

  return NextResponse.json({
    sort: config.sort,
    requests,
    // What it WOULD have cost, so a run cut short by errors is visibly cut
    // short rather than looking like a cheap success.
    requestsPlanned: estimateRequests(config),
    saved: { created, updated },
    // Every skip reason, counted. The single most useful number on the screen:
    // an empty queue with "39 quiet" beside it is a setting to change, and an
    // empty queue with no explanation is a bug report.
    skipped: skipTally,
    categories: perCategory,
  });
});
