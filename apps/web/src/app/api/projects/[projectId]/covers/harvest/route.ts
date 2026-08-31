import { NextResponse } from 'next/server';
import { withAuth, jsonBody, badRequest } from '@/server/route';
import { requireProjectPermission, type Caller } from '@/server/auth';
import { getCoversConfig, listCoversItems, saveHarvest } from '@/server/covers';
import { harvestSection, CoversReadError } from '@/modules/covers/reader';
import { normaliseSection } from '@/modules/covers/sections';
import { sportForSection } from '@/modules/covers/config';
import { buildItem, summariseHarvest } from '@/modules/covers/items';
import { writeActivityLog } from '@/server/activityLog';

// POST /api/projects/:projectId/covers/harvest
//
// Read one section, store the threads and their posts. NO ANALYSIS: this is
// phase 2 of the staged build, and the whole point of the stage is a list a
// person can look at before anything scores, drafts or ranks it.
//
// ════════════════════════════════════════════════════════════════════════════
// GATED ON items.fetch, WHICH IS THE `spend` TIER
//
// Nothing here calls a model, so it spends no credit — but it does spend
// somebody else's server: one request per section page and one per thread, paced
// 1.2 seconds apart process-wide. That is the same class of cost as a Reddit
// fetch and it gets the same permission rather than a new one.
//
// The budget is a cap in the project's settings, not a number the caller may
// raise: a request may ask for LESS than the configured limit and never more.
// ════════════════════════════════════════════════════════════════════════════

// A section page plus up to 25 threads at 1.2s apart, each up to 20s.
export const maxDuration = 300;

type Ctx = { params: Promise<{ projectId: string }> };

interface Body {
  section?: string;
  pages?: number;
  maxThreads?: number;
}

export const POST = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'items.fetch');

  const body = await jsonBody<Body>(req);
  const section = normaliseSection(String(body.section ?? ''));
  if (!section) return badRequest('A section is required.');

  const config = await getCoversConfig(projectId);
  const configured = config.sections.find((s) => s.slug === section);
  // An unconfigured section is refused rather than read with a null sport. The
  // roles are what make a section readable at all, and "we have not classified
  // this" is a different answer from "we read it and learned nothing".
  if (!configured) {
    return badRequest(`${section} is not one of this project's sections. Add it in Settings first.`);
  }

  const pages = Math.min(config.pagesPerSection, Math.max(1, Number(body.pages) || 1));
  const maxThreads = Math.min(config.maxThreadsPerScan, Math.max(0, Number(body.maxThreads) || config.maxThreadsPerScan));

  // ── A free rejection before a paid read ──────────────────────────────────
  // The listing row already says how many posts a thread holds, and we already
  // know how many we hold. A thread whose count has not moved has nothing new in
  // it, so opening it again spends a request to re-parse posts we already
  // stored. This is the same cost order the Reddit funnel follows: arithmetic on
  // free data before anything expensive.
  //
  // A thread whose stored count is null was read without its listing row, so
  // there is nothing to compare and it is read again rather than assumed
  // unchanged.
  const held = new Map(
    (await listCoversItems(projectId, { section, limit: 500 })).map((i) => [i.externalId, i]),
  );
  let skipped = 0;

  let harvest;
  try {
    harvest = await harvestSection(section, {
      pages,
      maxThreads,
      keep: (thread) => {
        const prior = held.get(thread.threadId);
        if (!prior || prior.postsOnSite === null || thread.postsOnSite === null) return true;
        const unchanged = thread.postsOnSite <= prior.postsOnSite;
        if (unchanged) skipped++;
        return !unchanged;
      },
    });
  } catch (err) {
    if (err instanceof CoversReadError) {
      return NextResponse.json({ error: err.message }, { status: err.status === 403 ? 502 : 502 });
    }
    throw err;
  }

  const sport = sportForSection(config, section);
  const byId = new Map(harvest.threads.map((t) => [t.threadId, t]));
  const built = harvest.read.map((thread) =>
    buildItem(projectId, thread, sport, byId.get(thread.threadId) ?? null),
  );

  const saved = await saveHarvest(projectId, built, caller.uid);
  const summary = summariseHarvest(section, harvest.threads.length, built, harvest.errors, skipped);

  await writeActivityLog({
    caller,
    action: 'covers.harvest',
    targetType: 'project',
    targetId: projectId,
    targetName: section,
    metadata: { ...summary, ...saved, requests: harvest.fetched },
    severity: harvest.errors.length > 0 ? 'warning' : 'info',
  });

  return NextResponse.json({
    summary,
    saved,
    requests: harvest.fetched,
    threads: built.map((b) => ({
      itemId: b.item.itemId,
      title: b.item.title,
      url: b.item.url,
      posts: b.posts.length,
      fixtureKey: b.item.fixtureKey,
      teams: b.item.entities.teams,
    })),
  });
});
