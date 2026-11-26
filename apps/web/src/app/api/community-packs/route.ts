import { NextResponse } from 'next/server';
import { requireGlobalPermission, type Caller } from '@/server/auth';
import { withAuth, jsonBody, badRequest } from '@/server/route';
import { applyPack, deletePack, listPacks, savePack } from '@/server/communityPacks';
import { normalizePackCommunities } from '@/modules/reddit/communityPacks';

// Community packs — named sets of subreddits added to many accounts at once.
//
//   GET                                          → { packs }
//   POST { action: 'save', id?, name, communities } → { pack }
//   POST { action: 'delete', id }                → { ok }
//   POST { action: 'apply', accountIds, communities } → { results }
//
// accounts.manage, like the rest of the warm-up settings. Packs are read through
// here rather than from the client, so the rules need no new collection.

export const GET = withAuth(async (_req: Request, caller: Caller) => {
  requireGlobalPermission(caller, 'accounts.manage');
  return NextResponse.json({ packs: await listPacks() });
});

export const POST = withAuth(async (req: Request, caller: Caller) => {
  requireGlobalPermission(caller, 'accounts.manage');
  const body = await jsonBody<{ action?: string; id?: unknown; name?: unknown; communities?: unknown; accountIds?: unknown }>(req);
  const id = typeof body.id === 'string' ? body.id.trim() : '';

  switch (body.action) {
    case 'save': {
      const name = typeof body.name === 'string' ? body.name.trim().slice(0, 60) : '';
      if (!name) return badRequest('A pack needs a name.');
      const communities = normalizePackCommunities(body.communities);
      if (!communities.length) return badRequest('A pack needs at least one subreddit.');
      return NextResponse.json({ pack: await savePack({ id: id || undefined, name, communities }, caller.profile.displayName) });
    }
    case 'delete':
      if (!id) return badRequest('Which pack?');
      await deletePack(id);
      return NextResponse.json({ ok: true });
    case 'apply': {
      const accountIds = Array.isArray(body.accountIds)
        ? [...new Set(body.accountIds.filter((a): a is string => typeof a === 'string' && a.length > 0))].slice(0, 200)
        : [];
      if (!accountIds.length) return badRequest('Choose at least one account.');
      const communities = normalizePackCommunities(body.communities);
      if (!communities.length) return badRequest('Choose at least one subreddit.');
      return NextResponse.json({ results: await applyPack(accountIds, communities, caller.profile.displayName) });
    }
    default:
      return badRequest('Unknown action.');
  }
});
