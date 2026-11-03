import { NextResponse } from 'next/server';
import { requireGlobalPermission, type Caller } from '@/server/auth';
import { withAuth, jsonBody, badRequest } from '@/server/route';
import { runActor, ModelUnavailableError } from '@/server/llm/resolve';
import { LlmError } from '@/server/llm';
import { applySuggestions, draftPersona, FinderError, savePersona, suggestCommunities } from '@/server/communityFinder';

// POST /api/accounts/:accountId/warmup/finder
//   { action: 'persona', hint? }       → a persona draft (not saved)
//   { action: 'save-persona', persona } → saves the approved persona
//   { action: 'suggest' }               → communities for the saved persona
//   { action: 'apply', picks }          → adds the approved ones, Browse + Follow,
//                                         plus Comment where a pick allows it
//
// accounts.manage, like the rest of the warm-up settings.

type Ctx = { params: Promise<{ accountId: string }> };

export const POST = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  requireGlobalPermission(caller, 'accounts.manage');
  const { accountId } = await ctx.params;
  const body = await jsonBody<{ action?: string; hint?: string; persona?: unknown; picks?: unknown }>(req);
  try {
    switch (body.action) {
      case 'persona':
        return NextResponse.json({ persona: await draftPersona(accountId, runActor(caller), String(body.hint ?? '')) });
      case 'save-persona':
        return NextResponse.json({ persona: await savePersona(accountId, body.persona) });
      case 'suggest':
        return NextResponse.json({ suggestions: await suggestCommunities(accountId, runActor(caller)) });
      case 'apply': {
        const picks = Array.isArray(body.picks)
          ? body.picks.map((p) => ({
              name: String((p as { name?: unknown })?.name ?? ''),
              keywords: Array.isArray((p as { keywords?: unknown })?.keywords) ? ((p as { keywords: unknown[] }).keywords.map(String)) : [],
              comment: (p as { comment?: unknown })?.comment === true,
            }))
          : [];
        if (!picks.length) return badRequest('Choose at least one community.');
        return NextResponse.json(await applySuggestions(accountId, picks, caller.profile.displayName));
      }
      default:
        return badRequest('Unknown action.');
    }
  } catch (err) {
    if (err instanceof FinderError || err instanceof ModelUnavailableError) return badRequest(err.message);
    if (err instanceof LlmError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
});
