import { NextResponse } from 'next/server';
import { withAuth, jsonBody, badRequest } from '@/server/route';
import { requireGlobalPermission, type Caller } from '@/server/auth';
import { modelByRef } from '@/lib/llm/catalog';
import { getWarmupModel, setWarmupModel } from '@/server/agentControl';

// The model that designs warm-up plans.
//
// Platform-wide, because warm-up is account-scoped — a Reddit identity is not
// owned by one client, so there is no project config to hang this on. Stored on
// agents/control beside the dry-run switch.
//
// Gated on accounts.manage, matching the warm-up generate route it feeds: the
// people who design warm-ups are the people who choose the model for them.

export const GET = withAuth(async (_req: Request, caller: Caller) => {
  requireGlobalPermission(caller, 'accounts.manage');
  return NextResponse.json({ warmupModel: await getWarmupModel() });
});

export const PUT = withAuth(async (req: Request, caller: Caller) => {
  requireGlobalPermission(caller, 'accounts.manage');

  const { warmupModel } = await jsonBody<{ warmupModel?: unknown }>(req);

  // null/'' means the platform default, same convention as the per-project
  // settings — so "unset" stays distinguishable from "explicitly DeepSeek".
  if (warmupModel === null || warmupModel === undefined || warmupModel === '') {
    await setWarmupModel(null, caller.uid, caller.profile.displayName);
    return NextResponse.json({ warmupModel: null });
  }

  if (typeof warmupModel !== 'string') return badRequest('Unknown warm-up model.');
  const meta = modelByRef(warmupModel);
  if (!meta) return badRequest('Unknown warm-up model.');
  // The designer parses the reply as JSON; a model without JSON mode would fall
  // back to the deterministic composer on every single run, silently.
  if (!meta.json) {
    return badRequest(`${meta.label} cannot return structured JSON, so it cannot design warm-up plans.`);
  }

  await setWarmupModel(warmupModel, caller.uid, caller.profile.displayName);
  return NextResponse.json({ warmupModel });
});
