import { NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { adminDb } from '@/server/admin';
import { requireProjectPermission, type Caller } from '@/server/auth';
import { withAuth, jsonBody, badRequest } from '@/server/route';
import { getRedditConfig } from '@/modules/reddit/store';
import { normalizeSubreddit } from '@/modules/reddit/rss';
import type { RedditModuleConfig } from '@/lib/types';

// The Reddit module's per-client configuration: which subreddits, which
// keywords, how the brand may be mentioned, what must never be said.
//
// Field-for-field the same as ML Studio's RedditProject minus the identity
// fields that moved up to Project. Keeping the shapes identical is what makes
// migration a re-parent rather than a transform, and keeps parity testable.

type Ctx = { params: Promise<{ projectId: string }> };

const EMPTY: RedditModuleConfig = {
  companyDescription: '',
  targetCustomer: '',
  productService: '',
  targetSubreddits: [],
  keywords: [],
  brandMentionStyle: '',
  forbiddenPhrases: [],
};

export const GET = withAuth<Ctx>(async (_req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'project.view');

  const config = await getRedditConfig(projectId);
  return NextResponse.json({ config: config ?? EMPTY, configured: Boolean(config) });
});

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).map((s) => s.trim()) : [];

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

  const config: RedditModuleConfig = {
    companyDescription: body.companyDescription?.trim() ?? '',
    targetCustomer: body.targetCustomer?.trim() ?? '',
    productService: body.productService?.trim() ?? '',
    targetSubreddits,
    keywords: [...new Set(strings(body.keywords))],
    brandMentionStyle: body.brandMentionStyle?.trim() ?? '',
    forbiddenPhrases: [...new Set(strings(body.forbiddenPhrases))],
  };

  await adminDb()
    .collection('projects')
    .doc(projectId)
    .collection('modules')
    .doc('reddit')
    .set({ ...config, updatedAt: FieldValue.serverTimestamp(), updatedBy: caller.uid }, { merge: true });

  return NextResponse.json({ config });
});
