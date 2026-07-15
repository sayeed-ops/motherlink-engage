import 'server-only';

// DeepSeek client.
//
// ML Studio declares DEEPSEEK_URL and DEEPSEEK_MODEL as local constants in BOTH
// analyze-post and generate-draft. This is the one copy, so switching model can
// never half-apply.
//
// Prepaid credit: when it runs out, calls fail rather than silently billing.
// That is a genuinely useful property and worth not losing.

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
export const DEEPSEEK_MODEL = 'deepseek-chat';

export interface DeepSeekUsage {
  inputTokens: number;
  outputTokens: number;
}

export class DeepSeekError extends Error {
  constructor(
    readonly status: 503 | 502,
    message: string,
  ) {
    super(message);
    this.name = 'DeepSeekError';
  }
}

interface RawResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * One call to DeepSeek. Returns the raw text plus token usage.
 *
 * Every analysis and draft stores the model, the prompt version, and these
 * token counts — that is what makes cost attributable and a result
 * reproducible back to the exact prompt that produced it. Worth preserving.
 */
export async function callDeepSeek({
  system,
  user,
  temperature,
  maxTokens,
  json,
}: {
  system: string;
  user: string;
  temperature: number;
  maxTokens: number;
  json: boolean;
}): Promise<{ content: string; usage: DeepSeekUsage }> {
  const key = process.env.DEEPSEEK_API_KEY?.trim();
  if (!key) {
    throw new DeepSeekError(503, 'DeepSeek is not configured. Set DEEPSEEK_API_KEY and restart.');
  }

  let res: Response;
  try {
    res = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        ...(json ? { response_format: { type: 'json_object' } } : {}),
        temperature,
        max_tokens: maxTokens,
      }),
    });
  } catch (err) {
    throw new DeepSeekError(502, `DeepSeek request failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new DeepSeekError(502, `DeepSeek returned ${res.status}: ${text.slice(0, 300)}`);
  }

  const body = (await res.json()) as RawResponse;
  const content = body.choices?.[0]?.message?.content;
  if (!content) throw new DeepSeekError(502, 'DeepSeek returned no content.');

  return {
    content,
    usage: {
      inputTokens: body.usage?.prompt_tokens ?? 0,
      outputTokens: body.usage?.completion_tokens ?? 0,
    },
  };
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
