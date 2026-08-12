// Shared vocabulary for third-party LLM providers.
//
// PURE — no 'server-only', no Firestore, no fetch. The server validates against
// these types and the browser renders from them, so they must run in both. Same
// convention as modules/reddit/approach.ts and warmup.ts.
//
// Nothing secret is described here. The credential DOCUMENT shape (which holds
// ciphertext) lives server-side in server/llm/credentials.ts; this file only
// describes what a provider and a model are.

/** Providers we can talk to. Both are OpenAI-compatible `/chat/completions`,
 *  which is why the existing DeepSeek request body works unchanged for both.
 *  OpenRouter additionally proxies Anthropic / OpenAI / Google models behind one
 *  key, so adding it does NOT mean adding their SDKs. */
export type LlmProviderId = 'deepseek' | 'openrouter';

/** A model, namespaced by the provider that serves it.
 *
 *  The namespace is load-bearing: `deepseek-chat` called directly and
 *  `deepseek-chat` called through OpenRouter are different credentials, different
 *  billing, and different availability. A bare model id could not tell them apart.
 *
 *  Format: `${LlmProviderId}:${providerModelId}` — e.g. `deepseek:deepseek-chat`,
 *  `openrouter:anthropic/claude-sonnet-5`. */
export type ModelRef = string;

export interface LlmProviderMeta {
  id: LlmProviderId;
  label: string;
  /** Chat-completions endpoint. */
  baseUrl: string;
  /** GET endpoint listing the models this key may use, or null if the provider
   *  has none. Used to snapshot `allowedModels` when a key is saved. */
  modelsUrl: string | null;
  /** What a valid key looks like, shown as a hint in the add-key form. */
  keyHint: string;
  docsUrl: string;
}

export interface LlmModelMeta {
  ref: ModelRef;
  provider: LlmProviderId;
  /** Exactly the string that goes into the request body's `model` field. */
  providerModelId: string;
  label: string;
  family: string;
  /** Whether the model honours `response_format: { type: 'json_object' }`.
   *
   *  First-class rather than a footnote because the analyse route hard-requires
   *  parseable JSON and returns a 502 otherwise — so the analysis picker must
   *  filter on this, or selecting the wrong model turns every run into a 502. */
  json: boolean;
  contextTokens: number;
  /** Rough latency class. The analyse route runs under `maxDuration = 60`, so a
   *  'slow' model is a genuine timeout risk the fast DeepSeek path never had. */
  speed: 'fast' | 'standard' | 'slow';
  note?: string;
}

/** Split a ModelRef into its parts, or null if it isn't one. */
export function parseModelRef(ref: string): { provider: LlmProviderId; providerModelId: string } | null {
  const idx = ref.indexOf(':');
  if (idx <= 0) return null;
  const provider = ref.slice(0, idx);
  const providerModelId = ref.slice(idx + 1);
  if (!providerModelId) return null;
  if (provider !== 'deepseek' && provider !== 'openrouter') return null;
  return { provider, providerModelId };
}
