import { NextResponse } from 'next/server';
import { withAuth, jsonBody, badRequest } from '@/server/route';
import { requireProjectPermission, type Caller } from '@/server/auth';
import { getDiscovery, setDiscoveryStatus } from '@/server/discovery';
import type { DiscoveryStatus } from '@/modules/knowledge/types';

// PATCH /api/projects/:projectId/knowledge/discoveries/:discoveryId
//
// The operator's decision on one candidate. Three of them are made here —
// Ignore, Review, and putting a row back to undecided.
//
// ADD IS NOT ONE OF THEM, and that is deliberate rather than an omission.
// Adding means reading the page and proposing an asset from it, which is the
// existing ingest route, and routing it through here would create a second path
// that produces assets — one that had never been subject to the quote checking
// the first one exists for. The client calls ingest (or paste, when the page is
// blocked), saves through the assets route, and that route marks the discovery
// as added. One way in.

type Ctx = { params: Promise<{ projectId: string; discoveryId: string }> };

interface Body {
  status?: string;
}

const DECIDABLE: DiscoveryStatus[] = ['ignored', 'review', 'new'];

export const PATCH = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId, discoveryId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'knowledge.manage');

  const body = await jsonBody<Body>(req);
  const status = body.status as DiscoveryStatus;

  if (!DECIDABLE.includes(status)) {
    return badRequest('A discovery can be ignored, kept for later, or put back to undecided.');
  }

  const discovery = await getDiscovery(projectId, discoveryId);
  if (!discovery) return NextResponse.json({ error: 'No such discovery.' }, { status: 404 });

  if (discovery.status === 'added') {
    // Reversing an add would leave the asset it created behind, with nothing
    // pointing at it. Deleting the asset is a separate, deliberate act on the
    // asset itself.
    return badRequest('That page has already been added. Delete the asset if you want it gone.');
  }

  await setDiscoveryStatus(projectId, discoveryId, status, {
    uid: caller.uid,
    name: caller.profile.displayName,
  });

  return NextResponse.json({ discoveryId, status });
});
