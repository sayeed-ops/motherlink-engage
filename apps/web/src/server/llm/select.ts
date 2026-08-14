import 'server-only';

// WHICH credential wins — the decision, separated from the fetching.
//
// Pulled out of resolve.ts so the ordering rule can be tested directly instead
// of through Firestore. It is the heart of the feature and the part most likely
// to be got subtly wrong, so it takes plain arrays in and returns a choice.
//
// The order is the one the feature was asked for: "give access to those APIs to
// any project I want; IF NOT, then the user should be able to add their api
// keys." A shared key the org deliberately assigned to this project beats a
// personal one; the personal key is the fallback when no grant exists.
//
// Two independent gates gate step 1, and they answer different questions:
//   grantedToProject  — is THIS CLIENT'S work allowed to bill this key?
//   mayUseShared      — is THIS PERSON trusted with org spend at all?
// They compose with AND. Keeping them separate is what lets one client's key
// stay pinned to one client while an individual is independently cut off from
// org spend everywhere.

import type { LlmProviderId, ModelRef } from '@/lib/llm/types';

/** Just the fields the decision needs — so tests need not build a whole doc. */
export interface SelectableCredential {
  credentialId: string;
  provider: LlmProviderId;
  scope: 'shared' | 'personal';
  status: 'active' | 'invalid' | 'disabled';
  allowedModels?: ModelRef[];
  grantedProjectIds?: string[];
  grantAllProjects?: boolean;
}

export interface Selection {
  credential: SelectableCredential | null;
  source: 'project' | 'personal' | null;
  /** True when a key for this provider was reachable but did not list the model.
   *  Lets the caller say "your key lacks this model" instead of "no key", which
   *  are different problems with different fixes. */
  sawKeyWithoutModel: boolean;
}

/** Is this shared credential usable by the given project?
 *
 *  A null projectId is account-scoped work (warm-up design). Only an
 *  all-projects key qualifies there — a key scoped to one client must never be
 *  spent on work that has no project context. */
export function grantedToProject(c: SelectableCredential, projectId: string | null): boolean {
  if (c.scope !== 'shared') return false;
  if (c.status !== 'active') return false;
  if (c.grantAllProjects) return true;
  if (!projectId) return false;
  return (c.grantedProjectIds ?? []).includes(projectId);
}

export function chooseCredential(args: {
  shared: SelectableCredential[];
  personal: SelectableCredential[];
  projectId: string | null;
  provider: LlmProviderId;
  ref: ModelRef;
  /** The caller's `canUseSharedKeys` entitlement, already resolved through
   *  mayUseSharedKeys(). Required, not defaulted — a caller that forgets to
   *  pass it should fail to compile rather than silently get org spend. */
  mayUseShared: boolean;
}): Selection {
  const { shared, personal, projectId, provider, ref, mayUseShared } = args;
  let sawKeyWithoutModel = false;

  // 1. A shared key granted to this project — for someone entitled to org spend.
  //
  // When they are not, the whole branch is skipped rather than filtered: a
  // granted key that lacks the model must not set sawKeyWithoutModel here, or
  // the eventual error would tell this person to "re-check the key in Settings"
  // about a key they cannot use and cannot see.
  if (mayUseShared) {
    const projectKeys = shared.filter((c) => c.provider === provider && grantedToProject(c, projectId));
    const granted = projectKeys.find((c) => (c.allowedModels ?? []).includes(ref));
    if (granted) return { credential: granted, source: 'project', sawKeyWithoutModel: false };
    if (projectKeys.length) sawKeyWithoutModel = true;
  }

  // 2. The caller's own key — the "if not" path.
  const mine = personal.filter(
    (c) => c.provider === provider && c.status === 'active' && c.scope === 'personal',
  );
  const own = mine.find((c) => (c.allowedModels ?? []).includes(ref));
  if (own) return { credential: own, source: 'personal', sawKeyWithoutModel: false };
  if (mine.length) sawKeyWithoutModel = true;

  // 3. Caller falls through to the platform env key.
  return { credential: null, source: null, sawKeyWithoutModel };
}
