import { NextResponse } from 'next/server';
import { adminDb } from '@/server/admin';
import { requireProjectPermission, type Caller } from '@/server/auth';
import { withAuth } from '@/server/route';

// GET /api/projects/:projectId/reddit/items
//
// The review queue: every fetched post with its latest analysis and drafts,
// joined server-side.
//
// ML Studio's opportunities page runs three separate unbounded client queries
// (posts, analyses, drafts, each `where projectId ==` with no limit) and joins
// them in the browser. That is three round-trips of everything to every tab.
// Here it is three server reads, joined once, and the client gets what it needs.

type Ctx = { params: Promise<{ projectId: string }> };

const iso = (v: unknown): string | null =>
  v && typeof v === 'object' && 'toDate' in v ? (v as { toDate(): Date }).toDate().toISOString() : null;

export const GET = withAuth<Ctx>(async (_req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'project.view');

  const project = adminDb().collection('projects').doc(projectId);

  const [itemsSnap, analysesSnap, draftsSnap] = await Promise.all([
    project.collection('items').get(),
    project.collection('analyses').get(),
    project.collection('drafts').get(),
  ]);

  // Keep only the newest analysis per item. Re-analysing writes a new record
  // rather than mutating the old one — the history of what the model said at a
  // given prompt version is worth keeping — but the queue only shows the latest.
  const latestAnalysis = new Map<string, Record<string, unknown>>();
  for (const doc of analysesSnap.docs) {
    const a = doc.data();
    const prev = latestAnalysis.get(a.itemId as string);
    const at = (a.createdAt as { toMillis?(): number } | undefined)?.toMillis?.() ?? 0;
    const prevAt = (prev?.createdAt as { toMillis?(): number } | undefined)?.toMillis?.() ?? -1;
    if (!prev || at > prevAt) latestAnalysis.set(a.itemId as string, a);
  }

  const draftsByItem = new Map<string, Record<string, unknown>[]>();
  for (const doc of draftsSnap.docs) {
    const d = doc.data();
    const list = draftsByItem.get(d.itemId as string) ?? [];
    list.push(d);
    draftsByItem.set(d.itemId as string, list);
  }

  const items = itemsSnap.docs.map((doc) => {
    const i = doc.data();
    const a = latestAnalysis.get(doc.id);
    const drafts = (draftsByItem.get(doc.id) ?? []).map((d) => ({
      draftId: d.draftId,
      body: d.body,
      status: d.status,
      promptVersion: d.promptVersion,
      createdAt: iso(d.createdAt),
    }));

    return {
      itemId: doc.id,
      externalId: i.externalId,
      subreddit: i.subreddit,
      title: i.title,
      body: i.body,
      author: i.author,
      permalink: i.permalink,
      score: i.score,
      numComments: i.numComments,
      createdAtSource: iso(i.createdAtSource),
      fetchedAt: iso(i.fetchedAt),
      processingStatus: i.processingStatus,
      isFavorite: Boolean(i.isFavorite),
      analysis: a
        ? {
            analysisId: a.analysisId,
            decision: a.decision,
            score: a.score,
            reason: a.reason,
            riskLevel: a.riskLevel,
            mentionRecommendation: a.mentionRecommendation,
            suggestedAngle: a.suggestedAngle,
            // Absent on anything analysed before prompt v3. That absence is
            // meaningful: those posts cannot appear in the Growth bucket until
            // re-analysed, and pretending otherwise would be a lie about the data.
            growthScore: a.growthScore ?? null,
            growthAngle: a.growthAngle ?? '',
            promptVersion: a.promptVersion,
            createdAt: iso(a.createdAt),
          }
        : null,
      drafts,
    };
  });

  // Newest first. Sorted here rather than in the query, matching ML Studio's
  // deliberate choice to avoid a composite index at this scale.
  items.sort((a, b) => (b.createdAtSource ?? '').localeCompare(a.createdAtSource ?? ''));

  return NextResponse.json({ items });
});
