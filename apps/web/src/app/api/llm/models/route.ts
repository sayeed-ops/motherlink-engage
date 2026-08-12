import { NextResponse } from 'next/server';
import { withAuth } from '@/server/route';
import { requireProjectPermission, type Caller } from '@/server/auth';
import { encryptionConfigured } from '@/server/crypto';
import { MODELS, DEFAULT_MODEL_REF } from '@/lib/llm/catalog';
import type { LlmProviderId, ModelRef } from '@/lib/llm/types';
import { listPersonalCredentials, listSharedCredentials } from '@/server/llm/credentials';
import { grantedToProject } from '@/server/llm/select';
import { getRedditConfig } from '@/modules/reddit/store';

// What this caller may actually run, for this project.
//
// The picker shows EVERY catalogue model — that is the "we can show all models
// available" half of the request. This endpoint supplies the other half: which
// of them are selectable, and when one is not, why.
//
// Entitlement is computed for the VIEWER, while a run happens as the RUNNER.
// With project-scoped grants those are usually the same set — everyone on a
// granted project shares the key — so the asymmetry only arises from personal
// keys. The UI says which source backs a model so that stays visible rather
// than surprising.

export interface ModelOption {
  ref: ModelRef;
  label: string;
  provider: LlmProviderId;
  family: string;
  json: boolean;
  speed: 'fast' | 'standard' | 'slow';
  note?: string;
  allowed: boolean;
  /** Why not, when allowed is false. */
  reason: 'no-key' | 'key-lacks-model' | null;
  /** Which credential would run it. 'env' is the shared platform key. */
  source: 'project' | 'personal' | 'env' | null;
  /** True when `source` is 'env': the platform key is not probed per model, so
   *  "available" there is an assumption rather than a verified fact. */
  unverified: boolean;
}

type Ctx = { params: Promise<Record<string, never>> };

export const GET = withAuth<Ctx>(async (req: Request, caller: Caller) => {
  const projectId = new URL(req.url).searchParams.get('projectId');

  // Reading a project's configured model is reading project data.
  if (projectId) await requireProjectPermission(caller, projectId, 'project.view');

  const [shared, personal] = encryptionConfigured()
    ? await Promise.all([listSharedCredentials(), listPersonalCredentials(caller.uid)])
    : [[], []];

  // Every model each source can reach, most-specific source winning.
  const bySource = new Map<ModelRef, 'project' | 'personal' | 'env'>();

  if (process.env.DEEPSEEK_API_KEY?.trim()) {
    for (const m of MODELS) if (m.provider === 'deepseek') bySource.set(m.ref, 'env');
  }
  if (process.env.OPENROUTER_API_KEY?.trim()) {
    for (const m of MODELS) if (m.provider === 'openrouter') bySource.set(m.ref, 'env');
  }
  for (const c of personal) {
    if (c.status !== 'active') continue;
    for (const ref of c.allowedModels ?? []) bySource.set(ref, 'personal');
  }
  // Last so a project grant outranks a personal key, matching resolve order.
  for (const c of shared) {
    if (!grantedToProject(c, projectId)) continue;
    for (const ref of c.allowedModels ?? []) bySource.set(ref, 'project');
  }

  // Does the caller hold ANY key for this provider? Distinguishes "you have no
  // key" from "your key doesn't list this model" — different fixes.
  const providersWithSomeKey = new Set<LlmProviderId>();
  for (const c of [...personal.filter((p) => p.status === 'active'), ...shared.filter((s) => grantedToProject(s, projectId))]) {
    providersWithSomeKey.add(c.provider);
  }
  if (process.env.DEEPSEEK_API_KEY?.trim()) providersWithSomeKey.add('deepseek');
  if (process.env.OPENROUTER_API_KEY?.trim()) providersWithSomeKey.add('openrouter');

  const models: ModelOption[] = MODELS.map((m) => {
    const source = bySource.get(m.ref) ?? null;
    return {
      ref: m.ref,
      label: m.label,
      provider: m.provider,
      family: m.family,
      json: m.json,
      speed: m.speed,
      note: m.note,
      allowed: source !== null,
      reason: source ? null : providersWithSomeKey.has(m.provider) ? 'key-lacks-model' : 'no-key',
      source,
      unverified: source === 'env',
    };
  });

  const config = projectId ? await getRedditConfig(projectId) : null;

  return NextResponse.json({
    models,
    defaultRef: DEFAULT_MODEL_REF,
    selection: {
      // undefined (field absent on an older config doc) and null both mean
      // "platform default" — normalise so the client has one case to handle.
      analysisModel: (config as { analysisModel?: string | null } | null)?.analysisModel ?? null,
      draftModel: (config as { draftModel?: string | null } | null)?.draftModel ?? null,
    },
  });
});
