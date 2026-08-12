// The model catalogue — every model the UI may OFFER.
//
// PURE (see ./types.ts). The server validates a configured model against this,
// and the browser renders the picker from it; one source of truth for both.
//
// This is the "show all models" half of the feature. Whether a given model is
// SELECTABLE is a separate question answered per credential at run time
// (`allowedModels`, snapshotted when a key is saved) — a curated list can say
// what exists, but only a live probe can say whether YOUR key reaches it.
//
// Adding a model means a deploy. That is the deliberate trade: a free-text
// model-id field turns every typo into a support ticket, and the `json` flag
// below cannot be inferred from a string.

import type { LlmModelMeta, LlmProviderMeta, ModelRef } from './types';

export const PROVIDERS: readonly LlmProviderMeta[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/chat/completions',
    modelsUrl: 'https://api.deepseek.com/models',
    keyHint: 'starts with sk-',
    docsUrl: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1/chat/completions',
    modelsUrl: 'https://openrouter.ai/api/v1/models',
    keyHint: 'starts with sk-or-',
    docsUrl: 'https://openrouter.ai/keys',
  },
];

export const PROVIDER_BY_ID: Readonly<Record<string, LlmProviderMeta>> = Object.fromEntries(
  PROVIDERS.map((p) => [p.id, p]),
);

// Model ids are the provider's own strings and must match byte-for-byte — they
// go straight into the request body. OpenRouter namespaces its own ids
// (`anthropic/claude-sonnet-5`), which is why a ref can contain two colons'
// worth of structure and parseModelRef splits on the FIRST one only.
export const MODELS: readonly LlmModelMeta[] = [
  // ---- DeepSeek direct ----
  {
    ref: 'deepseek:deepseek-chat',
    provider: 'deepseek',
    providerModelId: 'deepseek-chat',
    label: 'DeepSeek Chat',
    family: 'DeepSeek',
    json: true,
    contextTokens: 64_000,
    speed: 'fast',
    note: 'The current default. Prepaid credit, so it fails closed rather than billing on.',
  },
  {
    ref: 'deepseek:deepseek-reasoner',
    provider: 'deepseek',
    providerModelId: 'deepseek-reasoner',
    label: 'DeepSeek Reasoner',
    family: 'DeepSeek',
    json: false,
    contextTokens: 64_000,
    speed: 'slow',
    note: 'Reasoning model — does not support JSON mode, so it cannot be used for analysis.',
  },

  // ---- via OpenRouter ----
  {
    ref: 'openrouter:deepseek/deepseek-chat',
    provider: 'openrouter',
    providerModelId: 'deepseek/deepseek-chat',
    label: 'DeepSeek Chat (via OpenRouter)',
    family: 'DeepSeek',
    json: true,
    contextTokens: 64_000,
    speed: 'fast',
  },
  {
    ref: 'openrouter:anthropic/claude-haiku-4.5',
    provider: 'openrouter',
    providerModelId: 'anthropic/claude-haiku-4.5',
    label: 'Claude Haiku 4.5',
    family: 'Claude',
    json: true,
    contextTokens: 200_000,
    speed: 'fast',
  },
  {
    ref: 'openrouter:anthropic/claude-sonnet-5',
    provider: 'openrouter',
    providerModelId: 'anthropic/claude-sonnet-5',
    label: 'Claude Sonnet 5',
    family: 'Claude',
    json: true,
    contextTokens: 1_000_000,
    speed: 'standard',
  },
  {
    ref: 'openrouter:anthropic/claude-opus-5',
    provider: 'openrouter',
    providerModelId: 'anthropic/claude-opus-5',
    label: 'Claude Opus 5',
    family: 'Claude',
    json: true,
    contextTokens: 1_000_000,
    speed: 'slow',
    note: 'Most capable, slowest. Watch the 60s route timeout on analysis.',
  },
  {
    ref: 'openrouter:openai/gpt-5',
    provider: 'openrouter',
    providerModelId: 'openai/gpt-5',
    label: 'GPT-5',
    family: 'GPT',
    json: true,
    contextTokens: 400_000,
    speed: 'standard',
  },
  {
    ref: 'openrouter:google/gemini-3-pro',
    provider: 'openrouter',
    providerModelId: 'google/gemini-3-pro',
    label: 'Gemini 3 Pro',
    family: 'Gemini',
    json: true,
    contextTokens: 1_000_000,
    speed: 'standard',
  },
];

const BY_REF: Readonly<Record<string, LlmModelMeta>> = Object.fromEntries(MODELS.map((m) => [m.ref, m]));

export function modelByRef(ref: string): LlmModelMeta | undefined {
  return BY_REF[ref];
}

/** Every catalogue ref a given provider serves. Used as the `allowedModels`
 *  fallback when a provider has no usable /models endpoint. */
export function modelRefsForProvider(provider: string): ModelRef[] {
  return MODELS.filter((m) => m.provider === provider).map((m) => m.ref);
}

/** The model every project uses until someone picks otherwise — i.e. exactly
 *  what the product does today. Keeping this as a named constant is what lets a
 *  null `analysisModel` mean "unchanged" rather than "unset". */
export const DEFAULT_MODEL_REF: ModelRef = 'deepseek:deepseek-chat';
