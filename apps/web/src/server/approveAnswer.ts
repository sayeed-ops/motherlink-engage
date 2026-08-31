import 'server-only';

// Putting a researched (or imported) answer into the library.
//
// ════════════════════════════════════════════════════════════════════════════
// ONE APPROVAL, TWO CALLERS
//
// A person approving one answer and an operator approving eighty must do the
// same thing to a question, or the two paths drift and the bulk one quietly
// becomes the lenient one. Everything that decides what an approved answer
// BECOMES lives here; the routes decide only which questions to run it on.
//
// The rule this exists to protect: `textSource` is a claim about US, not about
// the page. A researched answer's pages were read by this server and every
// claim quote-checked against the text it got. An imported answer's were not.
// Both may enter the library and they must not look alike once inside.
// ════════════════════════════════════════════════════════════════════════════

import { getAsset, mergeIntoAsset, saveAsset } from './knowledge';
import { setQuestionReview } from './interview';
import { expiryFor } from '@/modules/knowledge/freshness';
import { decideDedupe, type InterviewQuestion } from '@/modules/knowledge/interview';

export interface ApproveActor {
  uid: string;
  name: string;
}

/** A cheap view of the library, for the duplicate check. */
export interface AssetIndexRow {
  assetId: string;
  title: string;
  sourceUrl: string;
  triggers: string[];
}

export type ApproveOutcome =
  | { action: 'created'; questionId: string; assetId: string; claims: number }
  | { action: 'merged'; questionId: string; assetId: string; claims: number; triggers: number; into: string }
  | { action: 'skipped'; questionId: string; reason: string };

/**
 * Approve one answer.
 *
 * `mergeInto` is decided by the caller — the single route uses the operator's
 * choice, the bulk route uses `decideDedupe` against a library index it keeps
 * up to date as it goes. Passing null always creates a new asset.
 */
export async function approveAnswer(
  projectId: string,
  question: InterviewQuestion,
  actor: ApproveActor,
  mergeInto: string | null = null,
): Promise<ApproveOutcome> {
  const answer = question.answer;
  if (!answer) {
    return { action: 'skipped', questionId: question.questionId, reason: 'No answer to approve.' };
  }

  const imported = answer.answerSource === 'imported';
  const now = Date.now();

  // See the header. This is the one line that must never be copied into a
  // second approval path and then forgotten.
  const textSource = imported ? 'unverified' : 'fetched';

  if (mergeInto) {
    const target = await getAsset(projectId, mergeInto);
    if (!target) {
      return { action: 'skipped', questionId: question.questionId, reason: 'The asset to merge into is gone.' };
    }

    const added = await mergeIntoAsset({
      projectId,
      assetId: mergeInto,
      triggers: answer.conversationTriggers,
      problems: answer.problemsSolved,
      exclusions: answer.notRelevantWhen,
      claims: answer.claims.map((c) => ({ text: c.claim, quote: c.quote, sourceUrl: c.sourceUrl })),
      textSource,
      actor,
      nowMs: now,
      expiresAtMs: expiryFor(now),
    });

    await setQuestionReview(projectId, question.questionId, 'approved', mergeInto, actor);
    return {
      action: 'merged',
      questionId: question.questionId,
      assetId: mergeInto,
      claims: added.claims,
      triggers: added.triggers,
      into: target.title,
    };
  }

  const { assetId, claimIds } = await saveAsset({
    projectId,
    title: answer.assetTitle,
    kind: answer.assetKind,
    purpose: answer.shortAnswer,
    problems: answer.problemsSolved,
    triggers: answer.conversationTriggers,
    exclusions: answer.notRelevantWhen,
    sourceUrl: answer.sourceUrls[0] ?? '',
    sourceHash: '',
    textSource,
    fetchFailure: null,
    // No snapshot: research reads several pages and keeps none of them whole,
    // so there is no single text this asset is the summary of. The first
    // re-crawl of its source URL establishes one.
    snapshotText: '',
    // A person chose to bring an imported answer into this project; no model of
    // ours proposed it.
    proposedBy: imported ? 'human' : 'model',
    model: answer.model,
    promptVersion: answer.promptVersion,
    claims: answer.claims.map((c) => ({ text: c.claim, quote: c.quote })),
    activate: true,
    actor,
    nowMs: now,
    expiresAtMs: expiryFor(now),
  });

  await setQuestionReview(projectId, question.questionId, 'approved', assetId, actor);
  return { action: 'created', questionId: question.questionId, assetId, claims: claimIds.length };
}

export interface BulkResult {
  created: number;
  merged: number;
  skipped: number;
  outcomes: ApproveOutcome[];
}

/**
 * Approve many answers in one go.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE LIBRARY INDEX GROWS AS THIS RUNS, AND THAT IS THE WHOLE POINT
 *
 * A questionnaire circles the same dozen features from different angles — the
 * real client file that prompted this asks about void bets three times in three
 * categories, all three citing the same two pages. Approving them one at a time
 * against a FIXED snapshot of the library makes three assets for one page, and
 * retrieval then returns three near-identical matches and spends the prompt
 * budget repeating itself.
 *
 * So each approval is checked against the library INCLUDING what this run has
 * already created. The first void-bets question makes the asset; the next two
 * see a shared source URL, score as an overlap, and fold into it.
 *
 * `dedupe: false` turns that off and creates one asset per answer, which is the
 * right choice when somebody is deliberately importing a set they intend to
 * split up by hand afterwards.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Sequential on purpose: `decideDedupe` has to see the asset the previous
 * question just created, and two parallel approvals of the same subject would
 * each find an empty library and both create one.
 */
export async function approveMany(
  projectId: string,
  questions: readonly InterviewQuestion[],
  index: AssetIndexRow[],
  actor: ApproveActor,
  opts: { dedupe?: boolean } = {},
): Promise<BulkResult> {
  const dedupe = opts.dedupe ?? true;
  const result: BulkResult = { created: 0, merged: 0, skipped: 0, outcomes: [] };
  const library = [...index];

  for (const question of questions) {
    if (!question.answer) {
      result.skipped++;
      result.outcomes.push({
        action: 'skipped',
        questionId: question.questionId,
        reason: 'Nothing was found for this one, so there is nothing to approve.',
      });
      continue;
    }

    // `duplicate` and `update` both mean "this belongs to an asset we already
    // have". They differ in confidence, not in what to do with them here.
    const verdict = dedupe ? decideDedupe(question.answer, library) : null;
    const target = verdict && verdict.action !== 'new' ? verdict.assetId : null;

    const outcome = await approveAnswer(projectId, question, actor, target);
    result.outcomes.push(outcome);

    if (outcome.action === 'created') {
      result.created++;
      // Immediately visible to the next question in the run.
      library.push({
        assetId: outcome.assetId,
        title: question.answer.assetTitle,
        sourceUrl: question.answer.sourceUrls[0] ?? '',
        triggers: question.answer.conversationTriggers,
      });
    } else if (outcome.action === 'merged') {
      result.merged++;
      // The merged answer's triggers now live on the target asset, so a later
      // question matching those phrases finds it too.
      const row = library.find((a) => a.assetId === outcome.assetId);
      if (row) row.triggers = [...new Set([...row.triggers, ...question.answer.conversationTriggers])];
    } else {
      result.skipped++;
    }
  }

  return result;
}
