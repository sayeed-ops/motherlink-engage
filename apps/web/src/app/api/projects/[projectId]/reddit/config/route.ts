import { NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { adminDb } from '@/server/admin';
import { requireProjectPermission, type Caller } from '@/server/auth';
import { withAuth, jsonBody, badRequest } from '@/server/route';
import { getRedditConfig } from '@/modules/reddit/store';
import { normalizeSubreddit } from '@/modules/reddit/rss';
import { EMPTY_REDDIT_CONFIG } from '@/modules/reddit/defaults';
import { modelByRef } from '@/lib/llm/catalog';
import type { RedditModuleConfig } from '@/lib/types';

// The Reddit module's per-client configuration: which subreddits, which
// keywords, how the brand may be mentioned, what must never be said.
//
// Field-for-field the same as ML Studio's RedditProject minus the identity
// fields that moved up to Project. Keeping the shapes identical is what makes
// migration a re-parent rather than a transform, and keeps parity testable.

type Ctx = { params: Promise<{ projectId: string }> };

export const GET = withAuth<Ctx>(async (_req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'project.view');

  const config = await getRedditConfig(projectId);
  return NextResponse.json({ config: config ?? EMPTY_REDDIT_CONFIG, configured: Boolean(config) });
});

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).map((s) => s.trim()) : [];

/** Sentinel for "a value was sent and it isn't a model we know".
 *
 *  Needed because `null` is itself meaningful here — it is how a project says
 *  "use the platform default" — so it cannot double as the failure value. */
const INVALID = Symbol('invalid-model-ref');

/** Read an optional model ref from the body: absent/empty → null (default),
 *  a known catalogue ref → itself, anything else → INVALID. */
function readModelRef(v: unknown): string | null | typeof INVALID {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string') return INVALID;
  return modelByRef(v) ? v : INVALID;
}

export const PUT = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'project.edit');

  const body = await jsonBody<Partial<RedditModuleConfig>>(req);

  // Same normalisation as ML Studio's ProjectForm: strip a leading r/, drop
  // anything that isn't a legal subreddit character, lowercase. Doing it here
  // rather than in the form means it holds no matter what calls the API.
  const targetSubreddits = [
    ...new Set(
      strings(body.targetSubreddits)
        .map((s) => normalizeSubreddit(s).replace(/[^a-z0-9_]/gi, '').toLowerCase())
        .filter(Boolean),
    ),
  ];

  if (targetSubreddits.length === 0) {
    return badRequest('At least one subreddit is required.');
  }

  // Model choices are validated against the CATALOGUE, not against the editor's
  // own entitlement — deliberately. A project manager may legitimately configure
  // a model that only the analyst on the team holds a key for; whether a given
  // run can proceed is decided at run time, per caller, by resolveModelForRun.
  const analysisModel = readModelRef(body.analysisModel);
  const draftModel = readModelRef(body.draftModel);

  if (analysisModel === INVALID) return badRequest('Unknown analysis model.');
  if (draftModel === INVALID) return badRequest('Unknown draft model.');

  // The analyse route parses the reply as JSON and 502s otherwise, so a model
  // without JSON mode would turn every run into a failure. Refuse it here
  // rather than letting it be saved and discovered later.
  if (analysisModel) {
    const meta = modelByRef(analysisModel);
    if (meta && !meta.json) {
      return badRequest(`${meta.label} cannot return structured JSON, so it cannot be used for analysis.`);
    }
  }

  const config: RedditModuleConfig = {
    companyDescription: body.companyDescription?.trim() ?? '',
    targetCustomer: body.targetCustomer?.trim() ?? '',
    productService: body.productService?.trim() ?? '',
    targetSubreddits,
    keywords: [...new Set(strings(body.keywords))],
    brandMentionStyle: body.brandMentionStyle?.trim() ?? '',
    forbiddenPhrases: [...new Set(strings(body.forbiddenPhrases))],
    analysisModel,
    draftModel,
  };

  await adminDb()
    .collection('projects')
    .doc(projectId)
    .collection('modules')
    .doc('reddit')
    .set({ ...config, updatedAt: FieldValue.serverTimestamp(), updatedBy: caller.uid }, { merge: true });

  return NextResponse.json({ config });
});
