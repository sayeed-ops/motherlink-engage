import 'server-only';

// DeepSeek client — now a thin shim over the provider-agnostic layer in
// server/llm/.
//
// WHY THIS FILE STILL EXISTS. It has three callers (analyze, draft, warmup) and
// exports four things they depend on, including a class they test with
// `instanceof`. Keeping the module at its path with an unchanged surface let the
// provider refactor land with zero call-site edits — which is the only way to be
// confident the parity-critical path (byte-identical prompts, reproducible
// `model` + promptVersion + token counts on every stored row) did not move.
//
// The original header's point still holds and is now enforced one level down:
// ML Studio declared the URL and model as local constants in BOTH analyze-post
// and generate-draft; there is still exactly one copy, so switching model can
// never half-apply.
//
// Prepaid credit: when DeepSeek's runs out, calls fail rather than silently
// billing. That is a genuinely useful property and worth not losing — note that
// a card-backed OpenRouter or OpenAI key does NOT have it.
//
// New code should import from '@/server/llm' directly and resolve a credential
// rather than calling callDeepSeek(), which is hard-wired to the env key.

import { callModel, envDeepSeekModel } from '@/server/llm';
import type { LlmCallInput, LlmCallResult } from '@/server/llm';

/** Kept under the old name so `err instanceof DeepSeekError` and `err.status`
 *  keep working unchanged in the analyze and draft routes. */
export { LlmError as DeepSeekError } from '@/server/llm';

export type DeepSeekUsage = LlmCallResult['usage'];

export const DEEPSEEK_MODEL = 'deepseek-chat';

/**
 * One call to DeepSeek on the platform's own key. Returns the raw text plus
 * token usage.
 *
 * Every analysis and draft stores the model, the prompt version, and these
 * token counts — that is what makes cost attributable and a result reproducible
 * back to the exact prompt that produced it. Worth preserving.
 */
export async function callDeepSeek(input: LlmCallInput): Promise<LlmCallResult> {
  return callModel(envDeepSeekModel(), input);
}

/** Strip wrappers the model adds despite the prompt. Ported verbatim. */
export function cleanDraft(s: string): string {
  let out = s.trim();
  if (out.startsWith('```')) {
    out = out
      .replace(/^```[a-z]*\n?/, '')
      .replace(/\n?```\s*$/, '')
      .trim();
  }
  if ((out.startsWith('"') && out.endsWith('"')) || (out.startsWith('“') && out.endsWith('”'))) {
    out = out.slice(1, -1).trim();
  }
  return out;
}
