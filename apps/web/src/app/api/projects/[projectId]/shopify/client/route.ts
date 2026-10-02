import { NextResponse } from 'next/server';
import { withAuth, jsonBody, badRequest } from '@/server/route';
import { requireProjectPermission, type Caller } from '@/server/auth';
import { adminDb } from '@/server/admin';
import { getShopifyConfig, saveShopifyConfig } from '@/server/shopify';
import { fromReddit, normaliseClientProfile } from '@/modules/shopify/client';

// PUT  /api/projects/:projectId/shopify/client — set the client details
// POST /api/projects/:projectId/shopify/client — copy them across from Reddit
//
// ════════════════════════════════════════════════════════════════════════════
// A COPY WITH A SYNC, NOT A SHARED RECORD
//
// Reddit keeps the same fields in `projects/{id}/modules/reddit`. Reading those
// directly would have been less code and is the wrong shape: it makes a
// Shopify-only project fill in a form labelled Reddit, and it couples two
// platforms that may want to sound different — a merchant forum is not a
// subreddit.
//
// So the sync is an ACTION somebody takes, its time is recorded, and the screen
// can say how old the copy is. A copy nobody can tell is stale is worse than no
// copy at all.
// ════════════════════════════════════════════════════════════════════════════

type Ctx = { params: Promise<{ projectId: string }> };

/** `project.settings`, not `project.view`. `forbiddenPhrases` is the only rule
 *  enforced against a generated reply, and `brandMentionStyle` decides how the
 *  client may be named — both are policy rather than preference. */
const PERMISSION = 'project.settings' as const;

export const PUT = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, PERMISSION);

  const body = await jsonBody<{ client?: unknown }>(req);
  const config = await getShopifyConfig(projectId);

  // Typing over a synced copy makes it no longer a copy. Clearing the stamp is
  // the honest record: the screen would otherwise claim these values came from
  // Reddit when half of them were edited here.
  const incoming = normaliseClientProfile(body.client);
  const edited = { ...incoming, syncedFromRedditAtMs: null };

  const saved = await saveShopifyConfig(projectId, { ...config, client: edited }, caller.uid);
  return NextResponse.json({ client: saved.client });
});

export const POST = withAuth<Ctx>(async (_req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, PERMISSION);

  const snap = await adminDb().collection('projects').doc(projectId).collection('modules').doc('reddit').get();
  if (!snap.exists) {
    return badRequest('This project has no Reddit module to copy from. Fill the details in here instead.');
  }

  const data = snap.data() ?? {};
  const incoming = fromReddit(data, Date.now());
  if (!incoming.companyDescription) {
    return badRequest('The Reddit module has no company description to copy. Fill it in there first, or type it here.');
  }

  const config = await getShopifyConfig(projectId);
  const saved = await saveShopifyConfig(projectId, { ...config, client: incoming }, caller.uid);

  return NextResponse.json({
    client: saved.client,
    // What actually came across, so "synced" is not a claim the screen has to
    // take on trust.
    copied: {
      companyDescription: !!saved.client.companyDescription,
      targetCustomer: !!saved.client.targetCustomer,
      productService: !!saved.client.productService,
      brandMentionStyle: !!saved.client.brandMentionStyle,
      forbiddenPhrases: saved.client.forbiddenPhrases.length,
    },
  });
});
