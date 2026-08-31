import { NextResponse } from 'next/server';
import { withAuth, jsonBody, badRequest } from '@/server/route';
import { requireProjectPermission, type Caller } from '@/server/auth';
import { callModel } from '@/server/llm';
import { resolveModelForRun, runActor, ModelUnavailableError } from '@/server/llm/resolve';
import { fetchPage, KnowledgeFetchError } from '@/server/knowledge';
import { forPrompt } from '@/modules/knowledge/extract';
import { buildIngestPrompt, parseProposal, INGEST_PROMPT_VERSION } from '@/modules/knowledge/prompts';
import { getRedditConfig } from '@/modules/reddit/store';

// POST /api/projects/:projectId/knowledge/ingest
//
// Read one page of the client's own site and PROPOSE an asset from it.
//
// SAVES NOTHING. That is the whole shape of this route: it fetches, it asks a
// model, it throws away every claim whose quote is not on the page, and it hands
// the survivors back for a person to look at. Writing happens in POST
// ../assets, when a human has agreed.
//
// The alternative — ingest-and-save, review later — was rejected for the reason
// the draft status exists at all: a model reading a marketing page will propose
// that the client is excellent at everything, and an unreviewed library is worse
// than no library, because the system will speak from it with confidence.

// The model call dominates; a page fetch plus one completion. Same budget as
// the analyse route, which does the same shape of work.
export const maxDuration = 60;

type Ctx = { params: Promise<{ projectId: string }> };

interface Body {
  url?: string;
}

export const POST = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  // Reading a page costs a model call, but the thing being built is the
  // knowledge base, so this is the knowledge permission rather than a spend one.
  // A holder of knowledge.manage can already add sources by hand; this only
  // changes how much typing it takes.
  await requireProjectPermission(caller, projectId, 'knowledge.manage');

  const body = await jsonBody<Body>(req);
  const url = body.url?.trim();
  if (!url) return badRequest('A page URL is required.');

  let page;
  try {
    page = await fetchPage(url, Date.now());
  } catch (err) {
    if (err instanceof KnowledgeFetchError) {
      // `canPaste` is the whole contract with the UI: it decides whether the
      // operator is offered the manual route or simply told no. A 403 from a
      // client help centre is the first case; a private address is the second,
      // and must never become the first.
      return NextResponse.json(
        { error: err.message, code: err.code, canPaste: err.pasteable },
        { status: err.status },
      );
    }
    throw err;
  }

  // The project's configured analysis model: this is a structured-output job of
  // exactly the kind analysis does, so it inherits that choice rather than
  // introducing a third setting nobody knows to look at.
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
    url: page.url,
    title: page.title,
    text: forPrompt(page.text),
  });

  const result = await callModel(model, {
    system,
    user,
    // Description, not composition. Variety here is somebody's asset library
    // changing shape depending on what time of day they imported a page.
    temperature: 0,
    maxTokens: 2000,
    json: true,
  });

  let raw: unknown;
  try {
    raw = JSON.parse(result.content);
  } catch {
    return NextResponse.json({ error: 'The model did not return usable JSON for that page.' }, { status: 502 });
  }

  // Verified against the FULL page text, not the truncated prompt copy: a quote
  // from the part we sent is on the page either way, and checking against the
  // whole document is the stricter, more honest test.
  const verified = parseProposal(raw, page.text);
  if (!verified) {
    return NextResponse.json({ error: 'The model could not describe that page as a single asset.' }, { status: 502 });
  }

  return NextResponse.json({
    textSource: 'fetched',
    page: { url: page.url, title: page.title, hash: page.hash, chars: page.text.length },
    proposal: verified.proposal,
    // Shown, deliberately. The operator learns how far the model reached, and a
    // page that produces five rejections and no claims is telling them something
    // about the page.
    rejected: verified.rejected,
    model: model.providerModelId,
    promptVersion: INGEST_PROMPT_VERSION,
    usage: result.usage,
  });
});
