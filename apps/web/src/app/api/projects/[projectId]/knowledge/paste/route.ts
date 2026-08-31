import { NextResponse } from 'next/server';
import { withAuth, jsonBody, badRequest } from '@/server/route';
import { requireProjectPermission, type Caller } from '@/server/auth';
import { callModel } from '@/server/llm';
import { resolveModelForRun, runActor, ModelUnavailableError } from '@/server/llm/resolve';
import { contentHash, forPrompt, normalisePasted } from '@/modules/knowledge/extract';
import { assertPublicHttpUrl, KnowledgeFetchError } from '@/modules/knowledge/url';
import { buildIngestPrompt, parseProposal, INGEST_PROMPT_VERSION } from '@/modules/knowledge/prompts';
import { getRedditConfig } from '@/modules/reddit/store';

// POST /api/projects/:projectId/knowledge/paste
//
// The manual route, for pages the server cannot read. A real 403 from a real
// client help centre is what made it necessary; a JavaScript-rendered page is
// the other common case.
//
// ════════════════════════════════════════════════════════════════════════════
// THIS DOES NOT BYPASS THE 403 — IT REPLACES US WITH A PERSON
//
// Nothing here retries the fetch, spoofs a User-Agent, or routes around the
// block. The site refused the server; that refusal stands. What changes is who
// supplies the text: an operator who can see the page in their own browser
// pastes it, and the record says so permanently.
//
// EVERYTHING ELSE IS IDENTICAL, deliberately. The same prompt, the same parser,
// the same quote check, the same human approval before anything is saved. The
// manual route is a different source of text, not a lower standard — the only
// thing it changes is what the evidence rests on, and that is written into the
// asset as `textSource: 'pasted'` rather than quietly dropped.
//
// SAVES NOTHING, like its sibling. POST ../assets does the writing, and re-runs
// this quote check against the text it is given.
// ════════════════════════════════════════════════════════════════════════════

export const maxDuration = 60;

type Ctx = { params: Promise<{ projectId: string }> };

interface Body {
  url?: string;
  text?: string;
  /** Which failure sent us here, carried through so the asset can record it. */
  fetchFailure?: string;
}

/** Enough text to describe a page and to check a quote against. Same threshold
 *  the fetch path uses for "this page has no readable prose", so the two routes
 *  agree about what counts as a page. */
const MIN_CHARS = 200;

export const POST = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'knowledge.manage');

  const body = await jsonBody<Body>(req);

  const rawUrl = body.url?.trim();
  if (!rawUrl) return badRequest('The page URL is still required — it is what the asset points at.');

  // The URL is validated exactly as strictly as on the fetched route. The manual
  // path exists because a page refused US, never because a URL was unacceptable,
  // and it must not become a way to attach text to an address the guard refuses.
  let url: URL;
  try {
    url = assertPublicHttpUrl(rawUrl);
  } catch (err) {
    if (err instanceof KnowledgeFetchError) return badRequest(err.message);
    throw err;
  }

  const text = normalisePasted(typeof body.text === 'string' ? body.text : '');
  if (text.length < MIN_CHARS) {
    return badRequest(
      `That is not enough text to work from — paste the readable content of the page (at least ${MIN_CHARS} characters).`,
    );
  }

  const config = await getRedditConfig(projectId);
  let model;
  try {
    model = await resolveModelForRun(runActor(caller), projectId, config?.analysisModel ?? null, {
      requireJson: true,
    });
  } catch (err) {
    if (err instanceof ModelUnavailableError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    throw err;
  }

  const { system, user } = buildIngestPrompt({
    url: url.toString(),
    // No <title> to read — the operator pasted prose, not a document. The model
    // is told there is none rather than being handed a guess.
    title: '',
    text: forPrompt(text),
  });

  const result = await callModel(model, {
    system,
    user,
    temperature: 0,
    maxTokens: 2000,
    json: true,
  });

  let raw: unknown;
  try {
    raw = JSON.parse(result.content);
  } catch {
    return NextResponse.json({ error: 'The model did not return usable JSON for that text.' }, { status: 502 });
  }

  const verified = parseProposal(raw, text);
  if (!verified) {
    return NextResponse.json(
      { error: 'The model could not describe that text as a single asset.' },
      { status: 502 },
    );
  }

  return NextResponse.json({
    textSource: 'pasted',
    page: {
      url: url.toString(),
      title: '',
      hash: contentHash(text),
      chars: text.length,
    },
    fetchFailure: body.fetchFailure?.trim() || null,
    proposal: verified.proposal,
    rejected: verified.rejected,
    model: model.providerModelId,
    promptVersion: INGEST_PROMPT_VERSION,
    usage: result.usage,
  });
});
