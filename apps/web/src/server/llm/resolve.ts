import 'server-only';

// Which key runs this call?
//
// The order comes straight from how the feature was asked for: "give access to
// those APIs to any project I want; IF NOT, then the user should be able to add
// their api keys."
//
//   1. a shared key granted to THIS project   — the org deliberately assigned it
//   2. the caller's own personal key          — the "if not" fallback
//   3. the platform env key                   — what every project uses today
//
// Project-scoped grants also compose with `projects/{pid}/members/{uid}`, which
// already answers "who may work on this". A per-user grant model would have
// meant two members of one project seeing different available models for the
// same configured setting.
//
// CACHING IS NOT OPTIONAL HERE. analyzeAll() in the Opportunities page loops
// items SEQUENTIALLY, one route call per item. Without a cache a 50-item run
// adds 100 credential reads for an answer that cannot change mid-run. The 30s
// TTL and invalidate-on-write mirror server/auth.ts so there is one cache idiom
// in this codebase, not two.

import { parseModelRef, type LlmProviderId, type ModelRef } from '@/lib/llm/types';
import { DEFAULT_MODEL_REF, modelByRef } from '@/lib/llm/catalog';
import { encryptionConfigured } from '@/server/crypto';
import { mayUseSharedKeys, type Caller } from '@/server/auth';
import { envDeepSeekModel } from './index';
import {
  decryptKey,
  listPersonalCredentials,
  listSharedCredentials,
  type LlmCredentialDoc,
} from './credentials';
import type { ResolvedModel } from './types';
import { chooseCredential } from './select';

/** The configured model cannot be run by this caller. Distinct from LlmError:
 *  nothing went wrong with a provider, the user simply has no way to make this
 *  call. Routes turn it into a 409 with instructions. */
export class ModelUnavailableError extends Error {
  constructor(
    readonly reason: 'no-key' | 'key-lacks-model' | 'not-json-capable' | 'unknown-model',
    message: string,
  ) {
    super(message);
    this.name = 'ModelUnavailableError';
  }
}

/**
 * Who is running this, and may they spend org money.
 *
 * A bare uid used to be enough. It no longer is, and this exists as an object
 * rather than a second positional argument so that adding the entitlement was a
 * COMPILE error at every call site instead of a silently-defaulted parameter.
 * There is no default: forgetting to pass it must not mean "yes".
 */
export interface RunActor {
  uid: string;
  mayUseSharedKeys: boolean;
}

/** The normal way to build one — from an authenticated route's caller. */
export function runActor(caller: Caller): RunActor {
  return { uid: caller.uid, mayUseSharedKeys: mayUseSharedKeys(caller) };
}

const TTL_MS = 30_000;

interface CacheEntry<T> {
  at: number;
  value: T;
}

const personalCache = new Map<string, CacheEntry<LlmCredentialDoc[]>>();
// Shared credentials are global, so one entry rather than one per user.
let sharedCache: CacheEntry<LlmCredentialDoc[]> | null = null;

async function personalFor(uid: string): Promise<LlmCredentialDoc[]> {
  const hit = personalCache.get(uid);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const value = await listPersonalCredentials(uid);
  personalCache.set(uid, { at: Date.now(), value });
  return value;
}

async function shared(): Promise<LlmCredentialDoc[]> {
  if (sharedCache && Date.now() - sharedCache.at < TTL_MS) return sharedCache.value;
  const value = await listSharedCredentials();
  sharedCache = { at: Date.now(), value };
  return value;
}

/** Call after any write that changes what someone can reach.
 *
 *  Pass a uid for a personal-key change; call with no argument for a shared-key
 *  or grant change, which can affect everyone. */
export function invalidateLlmCache(uid?: string): void {
  if (uid) personalCache.delete(uid);
  else personalCache.clear();
  sharedCache = null;
}

function toResolved(
  d: LlmCredentialDoc,
  providerModelId: string,
  ref: ModelRef,
  source: 'project' | 'personal',
): ResolvedModel {
  return {
    ref,
    provider: d.provider,
    providerModelId,
    apiKey: decryptKey(d),
    credentialId: d.credentialId,
    source,
  };
}

export interface ResolveOptions {
  /** The call needs `response_format: json_object`. The analyse route does; the
   *  draft route does not. A model without it turns every analysis into a 502,
   *  so this is checked before the call, not after. */
  requireJson?: boolean;
}

/**
 * Resolve a model reference to a runnable credential for this caller.
 *
 * `projectId` is null for account-scoped work (warm-up design), where only an
 * all-projects shared key or the caller's own key applies.
 *
 * `configuredRef == null` means "whatever the platform has always used" — the
 * env DeepSeek key. Every existing project is in that state and keeps behaving
 * exactly as it does today with no migration.
 */
export async function resolveModelForRun(
  actor: RunActor,
  projectId: string | null,
  configuredRef: ModelRef | null,
  opts: ResolveOptions = {},
): Promise<ResolvedModel> {
  const { uid, mayUseSharedKeys: mayUseShared } = actor;
  const ref = configuredRef ?? DEFAULT_MODEL_REF;

  const meta = modelByRef(ref);
  if (!meta) {
    throw new ModelUnavailableError(
      'unknown-model',
      `This project is set to use a model this build does not know about ("${ref}"). Pick another in the project's Reddit settings.`,
    );
  }
  if (opts.requireJson && !meta.json) {
    throw new ModelUnavailableError(
      'not-json-capable',
      `${meta.label} cannot return structured JSON, so it cannot be used for analysis. Pick a different model in the project's Reddit settings.`,
    );
  }

  const parsed = parseModelRef(ref);
  if (!parsed) throw new ModelUnavailableError('unknown-model', `"${ref}" is not a valid model reference.`);
  const { provider, providerModelId } = parsed;

  let sawKeyWithoutModel = false;

  if (encryptionConfigured()) {
    // The ordering rule itself lives in ./select.ts, free of Firestore so it can
    // be tested directly. This function's job is only to fetch and to decrypt.
    // Skip the shared read entirely for someone not entitled to org spend —
    // nothing in it could be chosen, so it is a Firestore query with no
    // possible effect on the outcome.
    const [sharedDocs, personalDocs] = await Promise.all([
      mayUseShared ? shared() : Promise.resolve([]),
      personalFor(uid),
    ]);
    const pick = chooseCredential({
      shared: sharedDocs,
      personal: personalDocs,
      projectId,
      provider,
      ref,
      mayUseShared,
    });
    if (pick.credential && pick.source) {
      return toResolved(pick.credential as LlmCredentialDoc, providerModelId, ref, pick.source);
    }
    sawKeyWithoutModel = pick.sawKeyWithoutModel;
  }

  // 3. The platform env key. Keeps every existing project working untouched —
  // for anyone still entitled to org spend.
  //
  // The entitlement gates THIS TOO, and that is the whole point rather than an
  // over-reach. The env key is the organisation's own provider account: letting
  // someone who has been moved onto their own key silently fall through to it
  // would make the setting decorative, since DeepSeek is the platform default
  // and would therefore keep working for them forever. Denied and keyless is a
  // deliberate dead end, and ModelUnavailableError below says exactly how to
  // leave it.
  const env = mayUseShared ? envFallback(provider, providerModelId, ref) : null;
  if (env) return env;

  // Distinguish "there is a key but it doesn't reach this model" from "there is
  // no key at all" — different problems with different fixes.
  if (sawKeyWithoutModel) {
    throw new ModelUnavailableError(
      'key-lacks-model',
      `The available ${provider} key does not have access to ${meta.label}. Re-check it in Settings → API keys, or pick a different model.`,
    );
  }
  // Advice, not just a diagnosis — and the right advice for THIS caller.
  // Telling someone who is not entitled to org spend to "ask an admin to grant
  // a key to this project" sends them to ask for something that would not help;
  // the grant already exists or would be ignored. Their only route is their own
  // key, so that is the only thing offered.
  throw new ModelUnavailableError(
    'no-key',
    mayUseShared
      ? `No ${provider} key is available to run ${meta.label}. Ask an admin to grant one to this project, or add your own in Settings → API keys.`
      : `No ${provider} key is available to run ${meta.label}. Your account uses its own API keys — add one in Settings → API keys.`,
  );
}

/** The env keys as ordinary credentials, so the platform default is one more
 *  source in the chain rather than a special case inside the transport. */
function envFallback(provider: LlmProviderId, providerModelId: string, ref: ModelRef): ResolvedModel | null {
  if (provider === 'deepseek') {
    if (!process.env.DEEPSEEK_API_KEY?.trim()) return null;
    return { ...envDeepSeekModel(), providerModelId, ref };
  }
  if (provider === 'openrouter') {
    const apiKey = process.env.OPENROUTER_API_KEY?.trim();
    if (!apiKey) return null;
    return { ref, provider, providerModelId, apiKey, credentialId: 'env:openrouter', source: 'env' };
  }
  return null;
}
