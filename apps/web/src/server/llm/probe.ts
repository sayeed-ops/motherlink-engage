import 'server-only';

// Does this key actually work, and which models does it reach?
//
// Two separate questions with very different weights:
//
//   The PROBE is the gate. One chat/completions with max_tokens: 1. It is the
//   only thing that distinguishes a valid key from a typo, a revoked key, or a
//   key with no credit left — which is precisely the failure the user asked us
//   to prevent ("they should only be able to select the ones their API allows").
//   A key that fails the probe is not saved.
//
//   DISCOVERY is a nicety. GET /models, intersected with our catalogue, narrows
//   what we offer. It must NEVER block saving a key: providers rate-limit it,
//   change its shape, or omit it entirely, and none of that means the key is
//   bad. When it fails we fall back to "every catalogue model for this
//   provider" and mark the record `assumed` so the UI can say so.

import { modelRefsForProvider, PROVIDER_BY_ID } from '@/lib/llm/catalog';
import type { LlmProviderId, ModelRef } from '@/lib/llm/types';

export interface ProbeResult {
  ok: boolean;
  /** User-facing reason when ok is false. Never contains the key. */
  error: string | null;
  allowedModels: ModelRef[];
  verification: 'probed' | 'assumed';
}

const PROBE_TIMEOUT_MS = 15_000;
const DISCOVERY_TIMEOUT_MS = 10_000;

function withTimeout(ms: number): { signal: AbortSignal; done: () => void } {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, done: () => clearTimeout(t) };
}

/** Cheapest possible real call. A 401/403 means the key is wrong; a 402 or a
 *  quota message means it is real but unusable — both are worth surfacing at
 *  paste time rather than during someone's analysis run. */
async function liveness(provider: LlmProviderId, apiKey: string, modelId: string): Promise<{ ok: boolean; error: string | null }> {
  const meta = PROVIDER_BY_ID[provider];
  const { signal, done } = withTimeout(PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(meta.baseUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelId, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
      signal,
    });
    if (res.ok) return { ok: true, error: null };

    const text = await res.text().catch(() => '');
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: `${meta.label} rejected that key (${res.status}). Check you pasted it whole.` };
    }
    if (res.status === 402) {
      return { ok: false, error: `${meta.label} accepted the key but the account has no credit.` };
    }
    if (res.status === 429) {
      return { ok: false, error: `${meta.label} is rate-limiting this key right now. Try again in a moment.` };
    }
    return { ok: false, error: `${meta.label} returned ${res.status}: ${text.slice(0, 200)}` };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { ok: false, error: `${meta.label} did not respond within ${PROBE_TIMEOUT_MS / 1000}s.` };
    }
    return { ok: false, error: `Could not reach ${meta.label}: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    done();
  }
}

/** Intersect the provider's own model list with our catalogue. Returns null on
 *  any failure — the caller treats null as "assume the full catalogue". */
async function discover(provider: LlmProviderId, apiKey: string): Promise<ModelRef[] | null> {
  const meta = PROVIDER_BY_ID[provider];
  if (!meta.modelsUrl) return null;
  const { signal, done } = withTimeout(DISCOVERY_TIMEOUT_MS);
  try {
    const res = await fetch(meta.modelsUrl, { headers: { Authorization: `Bearer ${apiKey}` }, signal });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: Array<{ id?: string }> };
    if (!Array.isArray(body.data)) return null;
    const live = new Set(body.data.map((m) => m?.id).filter((id): id is string => typeof id === 'string'));
    const refs = modelRefsForProvider(provider).filter((ref) => live.has(ref.slice(provider.length + 1)));
    // An empty intersection means the provider listed models but none are ours
    // — more likely a shape change on their side than a key with zero access,
    // so decline to answer rather than locking the user out of everything.
    return refs.length ? refs : null;
  } catch {
    return null;
  } finally {
    done();
  }
}

export async function probeCredential(provider: LlmProviderId, apiKey: string): Promise<ProbeResult> {
  const catalogueRefs = modelRefsForProvider(provider);
  if (!catalogueRefs.length) {
    return { ok: false, error: `No models are configured for ${provider}.`, allowedModels: [], verification: 'assumed' };
  }

  // Probe with the cheapest model we know this provider serves.
  const probeModelId = catalogueRefs[0].slice(provider.length + 1);
  const live = await liveness(provider, apiKey, probeModelId);
  if (!live.ok) {
    return { ok: false, error: live.error, allowedModels: [], verification: 'assumed' };
  }

  const discovered = await discover(provider, apiKey);
  return discovered
    ? { ok: true, error: null, allowedModels: discovered, verification: 'probed' }
    : { ok: true, error: null, allowedModels: catalogueRefs, verification: 'assumed' };
}
