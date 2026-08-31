import { NextResponse } from 'next/server';
import { withAuth, jsonBody } from '@/server/route';
import { requireProjectPermission, type Caller } from '@/server/auth';
import { fetchPage, KnowledgeFetchError, listClaims, listAssets, putSnapshot, recordCrawl } from '@/server/knowledge';
import { canRefetch, compareCrawl } from '@/modules/knowledge/freshness';

// POST /api/projects/:projectId/knowledge/recrawl
//
// The freshness loop. Re-reads the page behind each active asset and records
// what changed. NO MODEL IS CALLED — this is a fetch and a string comparison,
// which is the whole reason it can be run often and eventually on a schedule.
//
// It does not fix anything, and deliberately so. A changed page takes its asset
// out of use and puts it in front of a person; deciding what the change MEANS is
// the one part of this loop that needs judgement, and it is the part a model
// reading a diff would be worst at.

// A page fetch each, sequentially, over a library that starts small. Generous
// rather than optimistic — a slow client site should time out one page, not the
// whole sweep.
export const maxDuration = 120;

type Ctx = { params: Promise<{ projectId: string }> };

interface Body {
  /** Limit the sweep to these assets. Absent means every active one. */
  assetIds?: string[];
}

/** Between fetches of the same host. Their site, their bandwidth, and a burst of
 *  forty parallel requests to a client's help centre is a bad first impression. */
const GAP_MS = 400;

export const POST = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'knowledge.manage');

  const body = await jsonBody<Body>(req).catch(() => ({}) as Body);
  const only = Array.isArray(body.assetIds) ? new Set(body.assetIds) : null;

  const [assets, claims] = await Promise.all([listAssets(projectId), listClaims(projectId)]);
  const all = assets.filter((a) => a.status === 'active' && (!only || only.has(a.assetId)));

  // A pasted asset cannot be re-read by the server — that is why its text was
  // pasted. Trying anyway would record the same inevitable failure every sweep
  // and train everyone to ignore the report. They are counted and named instead,
  // because they DO still need looking at; their claims expire on the same TTL
  // as everyone else's, and a person has to be the one to look.
  const targets = all.filter((a) => canRefetch(a));
  const manual = all.filter((a) => !canRefetch(a));

  const checked: {
    assetId: string;
    title: string;
    verdict: string;
    missingQuotes: number;
    error?: string;
  }[] = [];

  for (const [i, asset] of targets.entries()) {
    if (i > 0) await sleep(GAP_MS);

    try {
      const page = await fetchPage(asset.sourceUrl, Date.now());
      const outcome = compareCrawl(asset, page, claims);

      // A vanished quote counts as a change even when the hash matches. The hash
      // is the cheap check; the quote is the one that means something, and a CMS
      // that re-renders identical boilerplate must not hide the fact that our
      // supporting sentence is gone.
      const changed = outcome.verdict === 'changed' || outcome.missingQuotes.length > 0;

      await recordCrawl(projectId, asset.assetId, page, changed, Date.now());

      // Keep the snapshot in step with the hash we just stored. Without this the
      // next sweep would diff against text two versions old and report a change
      // that had already been recorded.
      if (changed) {
        await putSnapshot(projectId, asset.assetId, {
          text: page.text,
          hash: page.hash,
          textSource: 'fetched',
          capturedBy: caller.uid,
          capturedByName: caller.profile.displayName,
          capturedAt: new Date(),
        });
      }
      checked.push({
        assetId: asset.assetId,
        title: asset.title,
        verdict: changed ? 'changed' : outcome.verdict,
        missingQuotes: outcome.missingQuotes.length,
      });
    } catch (err) {
      // One unreachable page must not abandon the sweep. An asset we could not
      // check is NOT marked changed — that would be punishing a client's brief
      // outage by taking their library offline.
      const message = err instanceof KnowledgeFetchError ? err.message : 'That page could not be read.';
      checked.push({
        assetId: asset.assetId,
        title: asset.title,
        verdict: 'unreadable',
        missingQuotes: 0,
        error: message,
      });
    }
  }

  return NextResponse.json({
    checked,
    changed: checked.filter((c) => c.verdict === 'changed').length,
    unreadable: checked.filter((c) => c.verdict === 'unreadable').length,
    // Named, not merely counted: "3 need a person" is only actionable if you
    // know which three.
    manual: manual.map((a) => ({ assetId: a.assetId, title: a.title })),
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
