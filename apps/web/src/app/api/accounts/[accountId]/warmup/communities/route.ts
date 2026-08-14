import { NextResponse } from 'next/server';
import { requireGlobalPermission, requireProjectPermission, type Caller } from '@/server/auth';
import { withAuth, jsonBody, badRequest } from '@/server/route';
import { accountExists } from '@/server/accounts';
import { saveWarmupCommunities, getWarmupCommunities } from '@/server/warmup';
import { getRedditConfig } from '@/modules/reddit/store';
import {
  normalizeCommunityList,
  normalizeKeywordList,
  mergeCommunityNames,
  SYNC_DEFAULT_ROLES,
} from '@/modules/reddit/subreddits';

// The account's warm-up community list — which subreddits it may touch and what
// each one is for.
//
// Gated on `accounts.manage`, the same gate as account CRUD and the warm-up
// plan. Reads happen client-side off the account doc; only writes come through
// here, and the list is normalised server-side so the client can propose a shape
// but never store an illegal name, an unknown role, or an over-cap list.

type Ctx = { params: Promise<{ accountId: string }> };

/** PUT — replace the list wholesale. The editor sends its whole working copy. */
export const PUT = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  requireGlobalPermission(caller, 'accounts.manage');
  const { accountId } = await ctx.params;

  if (!(await accountExists(accountId))) return badRequest('No such account.');

  const body = await jsonBody<{ communities?: unknown; keywords?: unknown }>(req);
  // An empty list is legitimate — it is how an operator clears the list — so
  // this deliberately does NOT reject [] the way the project config route
  // rejects an empty targetSubreddits. The walk already handles having nowhere
  // to go: it enters via Home only.
  if (!Array.isArray(body.communities)) return badRequest('`communities` must be an array.');

  const communities = normalizeCommunityList(body.communities);
  const keywords = normalizeKeywordList(body.keywords);
  await saveWarmupCommunities(accountId, communities, keywords, caller.uid);
  return NextResponse.json({ accountId, communities, keywords });
});

/** POST — merge a project's target subreddits into the list.
 *
 *  Requires permission on BOTH sides: `accounts.manage` to write the account,
 *  and `project.view` on the project being read. Holding the global account
 *  permission is not standing to read an arbitrary client's configuration —
 *  per-project isolation is the reason Engage exists, and a convenience route
 *  is exactly where it would quietly leak. */
export const POST = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  requireGlobalPermission(caller, 'accounts.manage');
  const { accountId } = await ctx.params;

  if (!(await accountExists(accountId))) return badRequest('No such account.');

  const body = await jsonBody<{ projectId?: string }>(req);
  const projectId = typeof body.projectId === 'string' ? body.projectId.trim() : '';
  if (!projectId) return badRequest('A projectId is required.');

  await requireProjectPermission(caller, projectId, 'project.view');

  const config = await getRedditConfig(projectId);
  const targets = Array.isArray(config?.targetSubreddits) ? config.targetSubreddits : [];
  if (!targets.length) return badRequest('That project has no target subreddits configured yet.');

  const existing = await getWarmupCommunities(accountId);
  const { merged, added, widened } = mergeCommunityNames(existing.communities, targets, SYNC_DEFAULT_ROLES);

  // Project keywords join the account's GLOBAL pool rather than being attached
  // to any one community: a project's keywords describe its whole topic area,
  // not which query surfaces which subreddit. Per-community pairing is a
  // judgement made in the editor.
  const incomingKeywords = normalizeKeywordList(config?.keywords);
  const keywords = normalizeKeywordList([...existing.keywords, ...incomingKeywords]);
  const addedKeywords = keywords.filter((k) => !existing.keywords.includes(k));

  // Nothing changed — still a success, but say so, because "synced" with no
  // visible difference reads as a broken button.
  if (added.length || widened.length || addedKeywords.length) {
    await saveWarmupCommunities(accountId, merged, keywords, caller.uid);
  }

  return NextResponse.json({ accountId, communities: merged, keywords, added, widened, addedKeywords });
});
