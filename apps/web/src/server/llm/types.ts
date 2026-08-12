import 'server-only';

// Server-side LLM vocabulary: what a call looks like, what comes back, and how
// failures are reported.
//
// LlmError replaces DeepSeekError. It keeps the same two-status shape (503 =
// not configured / our fault, 502 = the provider misbehaved) because both
// Reddit routes branch on `err.status` directly and return it verbatim.
// modules/reddit/deepseek.ts re-exports it under the old name so `instanceof
// DeepSeekError` keeps working at every existing call site.

import type { LlmProviderId, ModelRef } from '@/lib/llm/types';

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmCallInput {
  system: string;
  user: string;
  temperature: number;
  maxTokens: number;
  json: boolean;
}

export interface LlmCallResult {
  content: string;
  usage: LlmUsage;
}

/** 503 — we are not configured to make this call (missing/undecryptable key).
 *  502 — we made the call and the provider failed or returned nothing usable.
 *
 *  Both are returned straight to the client as the HTTP status, so the message
 *  is user-facing. It must never contain an API key or a decryption reason. */
export class LlmError extends Error {
  constructor(
    readonly status: 503 | 502,
    message: string,
  ) {
    super(message);
    // Kept as 'DeepSeekError' would have been misleading once other providers
    // exist, but nothing branches on `name` — only on `instanceof` and `status`.
    this.name = 'LlmError';
  }
}

/** A model plus the credential that unlocks it, resolved for one specific run.
 *
 *  `apiKey` is decrypted plaintext. It may only be handed to a provider HTTP
 *  client — never logged, never returned in a response body, never written to
 *  the activity log. See server/crypto.ts for the full invariant. */
export interface ResolvedModel {
  ref: ModelRef;
  provider: LlmProviderId;
  /** Exactly the string that goes into the request body's `model` field. */
  providerModelId: string;
  apiKey: string;
  /** The credential this came from, or `env:<provider>` for the env fallback. */
  credentialId: string;
  source: 'project' | 'personal' | 'env';
}
