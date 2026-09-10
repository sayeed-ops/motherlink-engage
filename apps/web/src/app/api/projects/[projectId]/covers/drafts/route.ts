import { NextResponse } from 'next/server';
import { withAuth, jsonBody, badRequest } from '@/server/route';
import { requireProjectPermission, type Caller } from '@/server/auth';
import { callModel } from '@/server/llm';
import { resolveModelForRun, runActor, ModelUnavailableError } from '@/server/llm/resolve';
import {
  decideDraft,
  getCalibration,
  getPerformanceCounts,
  listCoversDrafts,
  listOutcomes,
  measureOutcome,
  NotAnOpportunityError,
  recordPosted,
  runGeneration,
  saveDrafts,
} from '@/server/coversDrafts';
import { normaliseSection } from '@/modules/covers/sections';
import { summariseCampaign } from '@/modules/covers/outcome';

// POST  /api/projects/:projectId/covers/drafts — write variants for a triage run
// GET   /api/projects/:projectId/covers/drafts — read the review queue back
// PATCH /api/projects/:projectId/covers/drafts — record a person's decision
//
// ════════════════════════════════════════════════════════════════════════════
// ⚠️ NOTHING ON THIS ROUTE CAN POST, AND `approved` IS NOT A QUEUE
//
// PATCH records that a person read a draft and agreed with it. It enqueues
// nothing, because there is nothing to enqueue: no Covers job kind exists, the
// agent has no Covers vocabulary, and modules/covers/draft.ts has no state after
// `approved`. A person copies the text and posts it themselves, which is what
// phase 4 is for — COVERS-PLAN.md § The staged build, L1 Assisted.
//
// It is gated on `drafts.approve` — the REVERSIBLE tier — and never on
// `drafts.publish`, which exists for the irreversible act of queueing a job that
// a real account posts. When phase 6 adds a Covers job, the enqueue takes
// `drafts.publish` and this route keeps the weaker permission it actually needs.
// ════════════════════════════════════════════════════════════════════════════
//
// GENERATION IS GATED ON items.analyze — the model-spend tier, as triage is.
// Between two and four model calls per opportunity: one or two to write, one to
// score, and one to choose ONLY when two or three variants survived the free
// floors.

export const maxDuration = 300;

/** Opportunities per run. Low on purpose — each one costs several calls, and a
 *  phase-4 run exists to be read by a person, not to fill a queue. */
const MAX_OPPORTUNITIES = 10;

type Ctx = { params: Promise<{ projectId: string }> };

interface PostBody {
  runId?: string;
  section?: string;
  /** Draft for ONE opportunity — the row a person pressed Draft on.
   *
   *  Reddit has always worked this way (`{ itemId, analysisId }` on its own
   *  draft route) and Covers did not: the only way in was "write for the whole
   *  run", which is why the button could not say what it was about to do. When
   *  set, `runId`, `section` and `maxOpportunities` are all ignored. */
  analysisId?: string;
  maxOpportunities?: number;
}

export const POST = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'items.analyze');

  const body = await jsonBody<PostBody>(req);
  const section = body.section ? normaliseSection(String(body.section)) : undefined;

  let model;
  try {
    model = await resolveModelForRun(runActor(caller), projectId, null, { requireJson: true });
  } catch (err) {
    if (err instanceof ModelUnavailableError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    throw err;
  }

  const analysisId = String(body.analysisId ?? '').trim() || undefined;

  // A single pick is one opportunity by definition; the run cap is about how
  // much a BATCH may spend and has nothing to say about a button a person
  // pressed on a row they are looking at.
  const cap = analysisId
    ? 1
    : Math.max(1, Math.min(MAX_OPPORTUNITIES, Number(body.maxOpportunities) || MAX_OPPORTUNITIES));

  let run;
  try {
    run = await runGeneration(
      projectId,
      { runId: body.runId, section, analysisId, maxOpportunities: cap, nowMs: Date.now() },
      async (input) => {
        const result = await callModel(model, input);
        return { content: result.content, model: model.providerModelId };
      },
    );
  } catch (err) {
    // The id is real and the funnel's answer for it was "nothing to write".
    // That is a 400 the screen can show verbatim, not a 500.
    if (err instanceof NotAnOpportunityError) return badRequest(err.message);
    throw err;
  }

  const saved = await saveDrafts(projectId, run, caller.uid);

  return NextResponse.json({
    runId: run.runId,
    opportunities: run.opportunities,
    written: saved.written,
    // The bill, split three ways. A run that spent most of its money on critic
    // calls is a run where the floors are too loose, and that is only visible
    // if the numbers are separate.
    calls: run.calls,
    skipped: run.skipped,
    // NONE is an outcome, counted and returned like any other.
    selected: run.drafts.reduce<Record<string, number>>((acc, d) => {
      acc[d.selected] = (acc[d.selected] ?? 0) + 1;
      return acc;
    }, {}),
  });
});

export const GET = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'project.view');

  const url = new URL(req.url);

  // ⚠️ THE PERFORMANCE READS ARE OPT-IN, AND THAT IS A QUOTA FIX.
  //
  // This used to fetch outcomes, the campaign summary AND the calibration set on
  // every call — roughly 700 extra document reads — and the Covers page calls it
  // on every load and every tab switch. On the Spark plan's 50,000 reads a day
  // that is about twenty page loads, and exhausting it takes the WHOLE app down:
  // requireCaller reads a profile, so a read-blocked project renders as
  // "Authentication failed" and "No projects yet" with nothing actually lost.
  //
  // ⚠️ THE OPT-IN WAS THERE ALREADY AND IT DID NOTHING, because its only caller
  // set the flag unconditionally. So there are now TWO tiers and the screen uses
  // the cheap one first:
  //
  //   include=performanceCounts  →  2 reads. Are the panels worth offering?
  //   include=performance        →  ~700 reads. Only once a person expands them.
  //
  // A flag that every caller passes is not opt-in, it is a rename. The counts
  // tier exists so the screen can keep deciding for itself whether to show the
  // panels without that decision costing the day's quota.
  const include = url.searchParams.get('include');

  const performanceCounts =
    include === 'performanceCounts' ? await getPerformanceCounts(projectId) : null;

  // `getCampaign` re-read the SAME outcomes collection this line already read —
  // two identical 200-document queries in one Promise.all. Summarised from the
  // array instead: the campaign panel is a reduction of the outcomes, not a
  // second source of them.
  const [outcomes, calibration] =
    include === 'performance'
      ? await Promise.all([listOutcomes(projectId), getCalibration(projectId)])
      : [null, null];
  const campaign = outcomes ? summariseCampaign(outcomes) : null;

  // The heavy tiers answer about performance and nothing else. Listing the
  // drafts as well would put this route's most expensive read back on the path
  // of a request that only wanted the panels.
  if (include === 'performance' || include === 'performanceCounts') {
    return NextResponse.json({ outcomes, campaign, calibration, performanceCounts });
  }

  return NextResponse.json({
    drafts: await listCoversDrafts(projectId, {
      runId: url.searchParams.get('runId') ?? undefined,
      section: url.searchParams.get('section') ?? undefined,
      status: url.searchParams.get('status') ?? undefined,
      limit: Number(url.searchParams.get('limit')) || undefined,
    }),
  });
});

interface PatchBody {
  draftId?: string;
  status?: string;
  reason?: string;
  /** What the person would actually post. Empty means "as written" — and the
   *  draft's own text is never overwritten either way. */
  editedText?: string;
  tags?: string[];
  /** Phase 5: they posted it by hand. Records an outcome with everything
   *  measurable left null, because at that moment nothing has been measured. */
  posted?: { permalink?: string; postedText?: string };
  /** Phase 5: somebody went and looked. */
  measure?: {
    outcomeId: string;
    replies?: number | null;
    quoted?: boolean | null;
    threadPostsAfter?: number | null;
    moderation?: 'unknown' | 'survived' | 'removed' | 'deleted';
    consequence?: 'unknown' | 'none' | 'warned' | 'suspended' | 'banned';
    externalPostId?: string | null;
    notes?: string;
  };
}

export const PATCH = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'drafts.approve');

  const body = await jsonBody<PatchBody>(req);
  const draftId = String(body.draftId ?? '').trim();
  if (!draftId) return badRequest('A draftId is required.');

  const status = String(body.status ?? '');
  // Only the two a person can choose. `none` is the pipeline's own answer and
  // `pending` is where a draft starts; neither is a decision anybody makes, and
  // accepting them here would let a request overwrite a recorded outcome.
  if (status !== 'approved' && status !== 'rejected') {
    return badRequest('status must be approved or rejected.');
  }

  const by = { uid: caller.uid, name: caller.profile.displayName ?? '' };

  const { action } = await decideDraft(
    projectId,
    draftId,
    {
      status,
      reason: String(body.reason ?? ''),
      editedText: typeof body.editedText === 'string' ? body.editedText : undefined,
      tags: Array.isArray(body.tags) ? body.tags.filter((t): t is string => typeof t === 'string') : [],
    },
    by,
  );

  // Marking it posted is a SEPARATE act from approving, and deliberately so: a
  // person may approve today and post tomorrow, or approve and never post. An
  // approval that silently created an outcome would report replies-not-yet-
  // measured for things that were never on the forum.
  let outcomeId: string | null = null;
  if (body.posted) {
    if (status !== 'approved') return badRequest('Only an approved draft can be marked posted.');
    ({ outcomeId } = await recordPosted(
      projectId,
      { draftId, permalink: body.posted.permalink, postedText: body.posted.postedText },
      by,
    ));
  }

  if (body.measure?.outcomeId) {
    await measureOutcome(projectId, body.measure.outcomeId, body.measure, by);
  }

  return NextResponse.json({ ok: true, draftId, status, action, outcomeId });
});
