import { NextResponse } from 'next/server';
import { withAuth, jsonBody, badRequest } from '@/server/route';
import { requireProjectPermission, type Caller } from '@/server/auth';
import { callModel } from '@/server/llm';
import { resolveModelForRun, runActor, ModelUnavailableError } from '@/server/llm/resolve';
import { knownKeys, saveDiscoveries, walkDomains } from '@/server/discovery';
import { listAssets } from '@/server/knowledge';
import { buildCandidates, normaliseDomain } from '@/modules/knowledge/discovery';
import { buildClassifyPrompt, parseClassifications, CLASSIFY_PROMPT_VERSION } from '@/modules/knowledge/classify';
import { getRedditConfig } from '@/modules/reddit/store';
import type { DiscoveryRun } from '@/modules/knowledge/types';

// POST /api/projects/:projectId/knowledge/discover
//
// Find candidate pages on the client's approved domains, guess what each is
// probably for, and file them in the review queue.
//
// ════════════════════════════════════════════════════════════════════════════
// NOTHING HERE VERIFIES ANYTHING
//
// The output is a list of URLs with a guess attached. No page is read for its
// content, no claim is created, and no asset exists at the end of this route.
// Promoting a candidate is a separate, deliberate act by a person, and even then
// the claims only become citable if the existing ingest can actually read the
// page.
//
// Keeping that line visible in the code is the point: discovery produces
// confident-looking rows at scale, and the temptation to let them shortcut the
// verification they were never subject to is exactly how a knowledge base fills
// up with things nobody checked.
// ════════════════════════════════════════════════════════════════════════════

// A robots fetch, up to eight sitemaps and a dozen page reads, each spaced by
// half a second, plus the classification calls. Generous because it is paced on
// purpose — hurrying this is how a client's WAF learns our IP.
export const maxDuration = 300;

type Ctx = { params: Promise<{ projectId: string }> };

interface Body {
  domains?: string[];
}

/** Candidates per classification call. Big enough that one call does real work,
 *  small enough that a model asked to return fifty rows returns fifty. */
const BATCH = 25;

export const POST = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'knowledge.manage');

  const body = await jsonBody<Body>(req).catch(() => ({}) as Body);

  const domains = (Array.isArray(body.domains) ? body.domains : [])
    .map((d) => normaliseDomain(String(d)))
    .filter(Boolean);

  if (domains.length === 0) {
    return badRequest('Give at least one approved domain to look at, e.g. stake.com.');
  }
  if (domains.length > 5) {
    return badRequest('Five domains at a time is the limit — run it again for the rest.');
  }

  // --- 1. enumerate, politely ------------------------------------------------
  const walk = await walkDomains(domains);

  // --- 2. cut to candidates, for free ----------------------------------------
  const assets = await listAssets(projectId);
  const known = await knownKeys(
    projectId,
    assets.map((a) => a.sourceUrl),
  );

  const candidates = buildCandidates(walk.found, {
    domains,
    known,
    disallow: walk.disallow,
    limit: 120,
  });

  const run: DiscoveryRun = {
    domains,
    seen: walk.found.length,
    candidates: candidates.length,
    written: 0,
    skipped: walk.found.length - candidates.length,
    pagesFetched: walk.pagesFetched,
    notes: [...walk.notes],
  };

  if (candidates.length === 0) {
    run.notes.push(
      known.size > 0
        ? 'Nothing new — every page found is already in the library or has been decided on.'
        : 'No candidate pages were found on those domains.',
    );
    return NextResponse.json({ run, written: 0 });
  }

  // --- 3. classify, in batches ----------------------------------------------
  const config = await getRedditConfig(projectId);
  let model;
  try {
    model = await resolveModelForRun(runActor(caller), projectId, config?.analysisModel ?? null, {
      requireJson: true,
    });
  } catch (err) {
    if (err instanceof ModelUnavailableError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    throw err;
  }

  const classifications = new Map<string, ReturnType<typeof parseClassifications> extends Map<string, infer V> ? V : never>();

  for (let i = 0; i < candidates.length; i += BATCH) {
    const batch = candidates.slice(i, i + BATCH);
    const { system, user } = buildClassifyPrompt(
      batch.map((c) => ({ url: c.url, anchors: c.anchors })),
    );

    try {
      const result = await callModel(model, { system, user, temperature: 0, maxTokens: 3000, json: true });
      for (const [url, value] of parseClassifications(JSON.parse(result.content))) {
        classifications.set(url, value);
      }
    } catch {
      // A failed batch loses its guesses, not its pages. The candidates are
      // still written and simply show up unclassified, which an operator can
      // work with — losing the URLs entirely would mean re-walking the site.
      run.notes.push(`One batch of ${batch.length} could not be classified; those rows have no summary.`);
    }
  }

  // --- 4. file them ----------------------------------------------------------
  run.written = await saveDiscoveries(
    candidates.map((candidate) => ({
      projectId,
      candidate,
      classification: classifications.get(candidate.url) ?? null,
      model: model.providerModelId,
      promptVersion: CLASSIFY_PROMPT_VERSION,
    })),
  );

  return NextResponse.json({ run, written: run.written });
});
