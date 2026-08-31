import { NextResponse } from 'next/server';
import { withAuth, jsonBody } from '@/server/route';
import { requireProjectPermission, type Caller } from '@/server/auth';
import { listAssets, setAssetTriggers } from '@/server/knowledge';
import { getInterview } from '@/server/interview';
import { triggerPhrases } from '@/modules/knowledge/importAnswers';
import { tokenise } from '@/modules/knowledge/retrieval';

// POST /api/projects/:projectId/knowledge/assets/repair-triggers
//
// ════════════════════════════════════════════════════════════════════════════
// AN ASSET WHOSE TRIGGER IS A SENTENCE CAN NEVER BE RETRIEVED
//
// Retrieval requires EVERY token of a trigger to appear in the thread, so a
// trigger phrase of fifteen words fires on nothing. The first version of the
// answered-knowledge importer stored each question whole as its asset's only
// trigger, which made every imported asset silently inert — present in the
// library, counted in the totals, and unreachable by any post.
//
// This finds those assets and re-derives short phrases from their titles. It is
// a DRY RUN unless `apply` is true, because rewriting triggers changes what the
// library matches and a person should see the before and after first.
// ════════════════════════════════════════════════════════════════════════════

// The token count above which a trigger is a sentence rather than a phrase.
// Four allows "cash out on a multi"; fifteen-word questions are what this is for.
const MAX_TRIGGER_TOKENS = 4;

type Ctx = { params: Promise<{ projectId: string }> };

export const POST = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'knowledge.manage');

  const body = await jsonBody<{ apply?: boolean; clientName?: string }>(req);
  const apply = body.apply === true;

  // The client's own name makes a useless trigger — it only fires on posts that
  // already name them, which is the one case needing no help. Taken from the
  // interview rather than asked for, so a caller cannot forget it.
  const interview = await getInterview(projectId);
  const clientName =
    typeof body.clientName === 'string' && body.clientName ? body.clientName : (interview?.clientName ?? '');

  const assets = await listAssets(projectId);
  const repairs: { assetId: string; title: string; before: string[]; after: string[] }[] = [];

  for (const asset of assets) {
    const unusable = asset.triggers.filter((t) => tokenise(t).length > MAX_TRIGGER_TOKENS);
    if (unusable.length === 0) continue;

    const kept = asset.triggers.filter((t) => tokenise(t).length <= MAX_TRIGGER_TOKENS);

    // ⚠️ DERIVE FROM EVERY SENTENCE, NOT JUST THE TITLE.
    //
    // Bulk approve folds several questions into one asset, and each arrives as
    // another whole-sentence trigger. Deriving from the title alone throws the
    // merged ones away — an asset that had absorbed the deposit-bonus question
    // kept only the phrases of whichever question happened to name it, and a
    // post asking about deposit bonuses still matched nothing. The subjects an
    // asset absorbed are exactly what it should be findable by.
    const derived = [
      ...triggerPhrases(asset.title, clientName),
      ...unusable.flatMap((sentence) => triggerPhrases(sentence, clientName)),
    ];

    const after = [...new Set([...kept, ...derived])];

    // Never leave an asset with fewer triggers than it had: a repair that
    // empties the list would make it MORE inert, not less.
    if (after.length === 0) continue;

    repairs.push({ assetId: asset.assetId, title: asset.title, before: asset.triggers, after });
    if (apply) await setAssetTriggers(projectId, asset.assetId, after);
  }

  return NextResponse.json({
    applied: apply,
    assets: assets.length,
    repaired: repairs.length,
    repairs: repairs.slice(0, 100),
  });
});
