import { NextResponse } from 'next/server';
import { withAuth, jsonBody, badRequest } from '@/server/route';
import { requireProjectPermission, type Caller } from '@/server/auth';
import { fetchPage, KnowledgeFetchError, loadLibrary, saveAsset } from '@/server/knowledge';
import { setDiscoveryStatus } from '@/server/discovery';
import { assertPublicHttpUrl } from '@/modules/knowledge/url';
import { assetReadiness, claimStatus, expiryFor } from '@/modules/knowledge/freshness';
import { contentHash, normaliseForMatch, normalisePasted } from '@/modules/knowledge/extract';
import { ASSET_KINDS, type AssetKind, type TextSource } from '@/modules/knowledge/types';

// GET  /api/projects/:projectId/knowledge/assets   — the library, with freshness
// POST /api/projects/:projectId/knowledge/assets   — save a confirmed asset

// POST re-fetches the source page to verify quotes. One page, short timeout.
export const maxDuration = 60;

type Ctx = { params: Promise<{ projectId: string }> };

const strings = (v: unknown, max: number): string[] =>
  Array.isArray(v)
    ? v
        .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
        .map((s) => s.trim())
        .slice(0, max)
    : [];

export const GET = withAuth<Ctx>(async (_req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'project.view');

  const { assets, claims } = await loadLibrary(projectId);
  const now = Date.now();

  // Freshness is DERIVED here rather than stored, because it changes with the
  // passage of time alone — a stored copy is wrong the moment nothing happens,
  // and nothing happening is the normal state of a knowledge base.
  return NextResponse.json({
    assets: assets.map((asset) => {
      const readiness = assetReadiness(asset, claims, now);
      return {
        ...asset,
        readiness: {
          usable: readiness.usable,
          citable: readiness.citable,
          reason: readiness.reason,
          assertableCount: readiness.assertable.length,
        },
      };
    }),
    claims: claims.map((claim) => ({
      ...claim,
      status: claimStatus(claim, assets.find((a) => a.assetId === claim.assetId) ?? null, now),
    })),
  });
});

interface Body {
  title?: string;
  kind?: string;
  purpose?: string;
  problems?: unknown;
  triggers?: unknown;
  exclusions?: unknown;
  sourceUrl?: string;
  proposedBy?: string;
  /** 'fetched' (default) or 'pasted'. Pasted requires pageText. */
  textSource?: string;
  /** The attested page text, for the manual route only. */
  pageText?: string;
  /** Which fetch failure sent this down the manual route. */
  fetchFailure?: string;
  /** The discovery this was promoted from, if any. Marked added on success. */
  discoveryId?: string;
  model?: string;
  promptVersion?: string;
  claims?: unknown;
  activate?: boolean;
}

export const POST = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'knowledge.manage');

  const body = await jsonBody<Body>(req);

  const title = body.title?.trim();
  const purpose = body.purpose?.trim();
  const sourceUrl = body.sourceUrl?.trim();
  if (!title) return badRequest('The asset needs a title.');
  if (!purpose) return badRequest('The asset needs a purpose — one or two sentences on what it is.');
  if (!sourceUrl || !/^https?:\/\//i.test(sourceUrl)) {
    return badRequest('The asset needs the http(s) URL of the page it came from.');
  }

  const kind: AssetKind = (ASSET_KINDS as readonly string[]).includes(body.kind ?? '')
    ? (body.kind as AssetKind)
    : 'guide';

  const claimsIn = Array.isArray(body.claims)
    ? (body.claims as unknown[])
        .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
        .map((c) => ({
          text: typeof c.text === 'string' ? c.text.trim() : '',
          quote: typeof c.quote === 'string' ? c.quote.trim() : '',
        }))
        .filter((c) => c.text.length > 0 && c.quote.length > 0)
        .slice(0, 8)
    : [];

  // Three routes in, and the default is the strictest thing that could be
  // meant: a caller who says nothing gets the one that actually reads the page.
  const textSource: TextSource =
    body.textSource === 'pasted' ? 'pasted' : body.textSource === 'unverified' ? 'unverified' : 'fetched';
  const now = Date.now();

  // The URL is checked on BOTH routes. The manual route exists because a page
  // refused us, not because a URL was unacceptable — attaching pasted text to a
  // private address would launder past exactly what assertPublicHttpUrl refuses,
  // and would leave a "source" nobody can ever re-check.
  try {
    assertPublicHttpUrl(sourceUrl);
  } catch (err) {
    if (err instanceof KnowledgeFetchError) return badRequest(err.message);
    throw err;
  }

  let verifiedText: string;
  let sourceHash: string;

  if (textSource === 'unverified') {
    // ── DISCOVERED, NOT READ ────────────────────────────────────────────────
    //
    // The page was found by discovery and could not be read — a 403, or markup
    // that needs a browser. Recording it is worth doing: it keeps the URL, the
    // guess at what it is for, and the reason it failed, so it is a to-do item
    // rather than a page silently lost.
    //
    // It carries NO text, so it can carry no claims, and assetReadiness refuses
    // to make it usable. There is nothing here to build a reply on and nothing
    // to cite; the operator's next move is the paste route.
    if (claimsIn.length > 0) {
      return badRequest('An unread page cannot carry claims — there is nothing to check them against.');
    }
    verifiedText = '';
    sourceHash = '';
  } else if (textSource === 'pasted') {
    // ── THE HUMAN IS THE SOURCE, AND THE RECORD SAYS SO ─────────────────────
    //
    // There is no way for the server to check that this text came from that URL
    // — the whole reason this path exists is that the server cannot read the
    // page at all. So the quote check below is doing a NARROWER job than on the
    // fetched route: it catches the model claiming things its own input does not
    // support, which is the realistic failure, and it cannot catch a person
    // pasting the wrong page, which is why the asset is stamped `pasted` and
    // carries their name for as long as it exists.
    //
    // Being explicit about that boundary is the point. Pretending the check
    // means more than it does would be worse than not having it.
    const pasted = normalisePasted(typeof body.pageText === 'string' ? body.pageText : '');
    if (pasted.length < 200) {
      return badRequest(
        'Paste the page content first — there is not enough text here to check anything against.',
      );
    }
    verifiedText = pasted;
    sourceHash = contentHash(pasted);
  } else {
    // ── THE SERVER READS THE PAGE AGAIN RATHER THAN BEING TOLD WHAT IT SAID ──
    //
    // The cheaper design is to have the browser send back the text from the
    // ingest step. It proves nothing: the caller controls that text, so a
    // fabricated quote arrives with a fabricated page to match it.
    //
    // Fetching here also makes the stored hash and snapshot the text we actually
    // verified against, so the first re-crawl cannot report a phantom change,
    // and a page that became unreachable between reading and saving is caught
    // now rather than in three months.
    try {
      const page = await fetchPage(sourceUrl, now);
      verifiedText = page.text;
      sourceHash = page.hash;
    } catch (err) {
      if (err instanceof KnowledgeFetchError) {
        // Tell the client it can switch routes rather than leaving it stuck. A
        // page that blocked us at save time will block us every time.
        return NextResponse.json(
          {
            error: `That page could not be re-read to check it — ${err.message}`,
            code: err.code,
            canPaste: err.pasteable,
          },
          { status: err.status },
        );
      }
      throw err;
    }
  }

  if (claimsIn.length > 0) {
    const haystack = normaliseForMatch(verifiedText);
    const unsupported = claimsIn.find((c) => !haystack.includes(normaliseForMatch(c.quote)));
    if (unsupported) {
      return badRequest(`That sentence is not in the page text: "${unsupported.quote.slice(0, 120)}"`);
    }
  }

  const { assetId, claimIds } = await saveAsset({
    projectId,
    title,
    kind,
    purpose,
    problems: strings(body.problems, 6),
    triggers: strings(body.triggers, 8),
    exclusions: strings(body.exclusions, 5),
    sourceUrl,
    sourceHash,
    textSource,
    fetchFailure: textSource === 'pasted' ? (body.fetchFailure?.trim() || null) : null,
    snapshotText: verifiedText,
    proposedBy: body.proposedBy === 'human' ? 'human' : 'model',
    model: body.model?.trim() ?? '',
    promptVersion: body.promptVersion?.trim() ?? '',
    claims: claimsIn,
    // An unread page can never be confirmed: there is no content to agree with.
    // Forced here rather than trusted from the client, because it is the rule
    // that keeps a guess from becoming an asset the system will speak from.
    activate: textSource === 'unverified' ? false : body.activate !== false,
    actor: { uid: caller.uid, name: caller.profile.displayName },
    nowMs: now,
    expiresAtMs: expiryFor(now),
  });

  // Close the loop back to the review queue. Done AFTER the asset exists, so a
  // discovery is never marked added against an asset that failed to write —
  // and a failure here loses a status update, not the asset.
  if (body.discoveryId) {
    await setDiscoveryStatus(
      projectId,
      body.discoveryId.trim(),
      'added',
      { uid: caller.uid, name: caller.profile.displayName },
      assetId,
    ).catch(() => undefined);
  }

  return NextResponse.json({ assetId, claimIds, claims: claimIds.length, textSource }, { status: 201 });
});
