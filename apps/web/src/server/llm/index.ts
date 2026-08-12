import 'server-only';

// The one place a model gets called.
//
// callModel() dispatches on the resolved credential's provider. Today both
// providers are OpenAI-compatible so both land in the same transport; the switch
// exists so that adding a provider that ISN'T (Anthropic direct, say) is a new
// branch here rather than a second call path scattered through the routes —
// which is the mistake deepseek.ts's own header warns about ("this is the one
// copy, so switching model can never half-apply").
//
// Phase 0 note: nothing calls this with anything but the env-backed DeepSeek
// credential yet. Credential resolution arrives in phase 1.

import { PROVIDER_BY_ID } from '@/lib/llm/catalog';
import { callOpenAiCompatible } from './openaiCompat';
import { LlmError, type LlmCallInput, type LlmCallResult, type ResolvedModel } from './types';

export async function callModel(model: ResolvedModel, input: LlmCallInput): Promise<LlmCallResult> {
  const provider = PROVIDER_BY_ID[model.provider];
  if (!provider) throw new LlmError(503, `Unknown LLM provider "${model.provider}".`);

  switch (model.provider) {
    case 'deepseek':
    case 'openrouter':
      return callOpenAiCompatible(provider, model, input);
    default: {
      // Exhaustiveness guard: adding a LlmProviderId without a branch here is a
      // compile error, not a runtime surprise in the middle of an analysis run.
      const never: never = model.provider;
      throw new LlmError(503, `Provider "${String(never)}" has no transport.`);
    }
  }
}

/** The DeepSeek credential built from `DEEPSEEK_API_KEY` — the platform default
 *  and the path every project uses until someone configures otherwise.
 *
 *  Kept as a synthetic ResolvedModel (rather than a special case inside
 *  callModel) so the env key is just one more credential source, and the
 *  resolution logic in phase 1 can fall back to it without a separate branch. */
export function envDeepSeekModel(): ResolvedModel {
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) {
    throw new LlmError(503, 'DeepSeek is not configured. Set DEEPSEEK_API_KEY and restart.');
  }
  return {
    ref: 'deepseek:deepseek-chat',
    provider: 'deepseek',
    providerModelId: 'deepseek-chat',
    apiKey,
    credentialId: 'env:deepseek',
    source: 'env',
  };
}

export { LlmError } from './types';
export type { LlmCallInput, LlmCallResult, LlmUsage, ResolvedModel } from './types';
