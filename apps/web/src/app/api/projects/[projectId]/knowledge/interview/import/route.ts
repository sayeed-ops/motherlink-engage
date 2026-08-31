import { NextResponse } from 'next/server';
import { withAuth, jsonBody, badRequest } from '@/server/route';
import { requireProjectPermission, type Caller } from '@/server/auth';
import { applyAnswerImport, listQuestions, setInterviewCounts } from '@/server/interview';
import {
  planAnswerImport,
  readImportFile,
  type ImportDecision,
} from '@/modules/knowledge/importAnswers';

// POST /api/projects/:projectId/knowledge/interview/import
//
// Import research that was done somewhere else — answers, statuses, the URLs
// that were read — as PROPOSALS in the review queue.
//
// ════════════════════════════════════════════════════════════════════════════
// TWO CALLS, AND THE FIRST ONE WRITES NOTHING
//
//   { file }                → the plan: what this file would do, row by row
//   { file, decisions: {…} } → apply it
//
// The dry run is not a convenience. Some of these rows overwrite answers that
// were researched against pages this server read; a person has to be able to see
// which ones before anything happens, and change them.
//
// The second call re-plans server-side and honours a decision only if the fresh
// row offers it. The browser therefore chooses between options the server
// generated — it never says which document to write.
//
// THIS IS NOT THE QUESTIONS-ONLY IMPORT. That one lives on `interview/export`
// and still exists, unchanged, for restoring a questionnaire without its
// answers. See modules/knowledge/importAnswers.ts for why answers may come
// through this door and claims may not.
// ════════════════════════════════════════════════════════════════════════════

type Ctx = { params: Promise<{ projectId: string }> };

interface Body {
  /** The parsed file, whole. Sent again on apply so the plan is recomputed
   *  from the same input rather than trusted from a previous response. */
  file?: unknown;
  /** questionKey → the decision the operator picked. Absent keys keep the
   *  plan's own default. */
  decisions?: Record<string, string>;
  /** The file's name, recorded on every answer it produces. */
  fileName?: string;
  /** Present on the second call. Without it this is a dry run. */
  apply?: boolean;
}

export const POST = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'knowledge.manage');

  const body = await jsonBody<Body>(req);
  const incoming = readImportFile(body.file);

  if (incoming.length === 0) {
    return badRequest(
      'No questions could be read from that file. It needs a `questions` array, each with a `question`.',
    );
  }

  const existing = await listQuestions(projectId);
  const plan = planAnswerImport(existing, incoming);

  if (!body.apply) {
    return NextResponse.json({
      plan: {
        counts: plan.counts,
        rows: plan.rows.map((row) => ({
          key: row.key,
          question: row.question,
          category: row.incoming.category,
          decision: row.decision,
          choices: row.choices,
          reason: row.reason,
          losesEvidence: row.losesEvidence,
          incoming: {
            status: row.incoming.status,
            answerText: row.incoming.answerText,
            sourcesRead: row.incoming.sourcesRead,
            note: row.incoming.note,
            notFoundReason: row.incoming.notFoundReason,
            priority: row.incoming.priority,
          },
          existing: row.existing
            ? {
                status: row.existing.status,
                review: row.existing.review,
                answerText: row.existing.answerText,
                sourcesRead: row.existing.sourcesRead,
                claimCount: row.existing.claimCount,
                answerSource: row.existing.answerSource,
              }
            : null,
        })),
      },
      // Said on the screen, every time, because it is the whole basis on which
      // these answers are allowed in at all.
      note: 'Imported answers arrive as proposals with no claims. They can shape a reply; they cannot be the evidence behind a stated fact until a person verifies a quote.',
    });
  }

  const decisions: Record<string, ImportDecision> = {};
  for (const [key, value] of Object.entries(body.decisions ?? {})) {
    decisions[key] = value as ImportDecision;
  }

  const result = await applyAnswerImport(projectId, plan.rows, decisions, {
    uid: caller.uid,
    name: caller.profile.displayName,
    fileLabel: String(body.fileName ?? 'import.json').slice(0, 120),
    nowMs: Date.now(),
  });

  const all = await listQuestions(projectId);
  await setInterviewCounts(projectId, all.length);

  return NextResponse.json({ ...result, total: all.length });
});
