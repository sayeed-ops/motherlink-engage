import 'server-only';

// One call to an OpenAI-compatible /chat/completions endpoint.
//
// This is modules/reddit/deepseek.ts's request body, lifted verbatim and
// parameterised by url / key / model. Nothing about the wire format changed —
// that is deliberate, because this path produces every analysis and draft in the
// product and the prompts are byte-identical to ML Studio's for parity testing.
// A DeepSeek call made through here is indistinguishable from the old one.
//
// DeepSeek, OpenRouter, OpenAI, Groq and Together all speak this shape. Anthropic
// does NOT (different endpoint, x-api-key + anthropic-version headers, system as
// a top-level field, no response_format) — reaching Claude goes through
// OpenRouter instead, which is what keeps this file the only transport we need.

import type { LlmProviderMeta } from '@/lib/llm/types';
import { LlmError, type LlmCallInput, type LlmCallResult, type ResolvedModel } from './types';
import { describeNetworkError, isTransientNetworkError, withNetworkRetry } from '@/lib/netError';

interface RawResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

// Errors are returned to the browser verbatim, so they use the provider's
// display label ("DeepSeek"), not its id ("deepseek") — these strings are the
// ones the old client produced and users have seen.
export async function callOpenAiCompatible(
  provider: LlmProviderMeta,
  model: ResolvedModel,
  { system, user, temperature, maxTokens, json }: LlmCallInput,
): Promise<LlmCallResult> {
  // One more try when the line drops — before the reply, or part-way through
  // it. An HTTP error is the provider answering, and is not retried.
  const send = () =>
    fetch(provider.baseUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${model.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model.providerModelId,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        ...(json ? { response_format: { type: 'json_object' } } : {}),
        temperature,
        max_tokens: maxTokens,
      }),
    });

  let res: Response;
  let body: RawResponse | null;
  try {
    ({ res, body } = await withNetworkRetry(async () => {
      const res = await send();
      return { res, body: res.ok ? ((await res.json()) as RawResponse) : null };
    }));
  } catch (err) {
    if (isTransientNetworkError(err)) throw new LlmError(502, describeNetworkError(`${provider.label} request failed`, err));
    if (err instanceof SyntaxError) throw new LlmError(502, `${provider.label} returned a reply that is not JSON.`);
    throw new LlmError(502, `${provider.label} request failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!res.ok || !body) {
    const text = await res.text().catch(() => '');
    throw new LlmError(502, `${provider.label} returned ${res.status}: ${text.slice(0, 300)}`);
  }

  // OpenRouter can answer 200 with an error object in the body (upstream refused,
  // out of credit, model unavailable) rather than a non-2xx — DeepSeek does not.
  // Without this the caller gets the generic "no content" below and no clue why.
  if (body.error?.message) {
    throw new LlmError(502, `${provider.label} returned an error: ${body.error.message.slice(0, 300)}`);
  }

  const content = body.choices?.[0]?.message?.content;
  if (!content) throw new LlmError(502, `${provider.label} returned no content.`);

  return {
    content,
    usage: {
      inputTokens: body.usage?.prompt_tokens ?? 0,
      outputTokens: body.usage?.completion_tokens ?? 0,
    },
  };
}
