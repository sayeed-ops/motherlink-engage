import 'server-only';

import { FieldValue } from 'firebase-admin/firestore';
import { adminDb } from './admin';
import type { RedditAccountStatus } from '@/modules/reddit/types';
import { accountPlatform, cleanUsername, type AccountPlatform } from '@/modules/accounts/platform';

// Posting accounts — the identities the tool can post FROM, on Reddit or the
// Shopify Community (`platform`, absent = Reddit; see modules/accounts/platform).
//
// Top-level and global, not per-project: one identity posts across several
// clients, and its rate rails belong to the identity. NO credentials are stored
// here — the login lives in the account's AdsPower browser profile on the
// posting Mac; `username` is only the wrong-account safeguard the agent checks.
//
// Reads happen client-side (rules: any signed-in user may read — the picker
// needs them and they hold no secrets). Writes are server-only and gated on the
// `accounts.manage` global permission. ML Studio wrote these from the browser
// under allow-all rules.

export const ACCOUNT_STATUSES: readonly RedditAccountStatus[] = [
  'active',
  'warming',
  'flagged',
  'banned',
] as const;

/** The mutable, human-set fields of an account. Counters (postCountToday, …) are
 *  never client-set — they move only via the posting path. */
export interface AccountInput {
  /** Set at creation only — ignored on update. */
  platform?: AccountPlatform;
  label: string;
  username: string;
  adsPowerProfileId: string;
  status: RedditAccountStatus;
  dailyCap: number;
  minIntervalMinutes: number;
  karma: number;
  notes: string;
}

const accounts = () => adminDb().collection('accounts');

/** Normalise + bound the editable fields, shared by create and update. */
function sanitize(input: Partial<AccountInput>, platform: AccountPlatform): Partial<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  if (input.label !== undefined) out.label = String(input.label).trim();
  if (input.username !== undefined) out.username = cleanUsername(input.username, platform);
  if (input.adsPowerProfileId !== undefined) out.adsPowerProfileId = String(input.adsPowerProfileId).trim();
  if (input.status !== undefined && ACCOUNT_STATUSES.includes(input.status)) out.status = input.status;
  if (input.dailyCap !== undefined) out.dailyCap = Math.max(1, Math.round(Number(input.dailyCap) || 1));
  if (input.minIntervalMinutes !== undefined)
    out.minIntervalMinutes = Math.max(0, Math.round(Number(input.minIntervalMinutes) || 0));
  if (input.karma !== undefined) out.karma = Math.round(Number(input.karma) || 0);
  if (input.notes !== undefined) out.notes = String(input.notes).trim();
  return out;
}

export async function createAccount(
  input: AccountInput,
  createdBy: string,
  createdByName: string,
): Promise<string> {
  const ref = accounts().doc();
  const platform = accountPlatform(input);
  await ref.set({
    accountId: ref.id,
    platform,
    ...sanitize(input, platform),
    // Rolling-window counters start clean. Only the posting path advances them.
    postCountToday: 0,
    postCountResetAt: FieldValue.serverTimestamp(),
    lastPostAt: null,
    createdBy,
    createdByName,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  return ref.id;
}

export async function accountExists(accountId: string): Promise<boolean> {
  return (await accounts().doc(accountId).get()).exists;
}

/** Load one account's raw doc (Timestamps intact), or null. */
export async function getAccount(accountId: string): Promise<Record<string, unknown> | null> {
  const snap = await accounts().doc(accountId).get();
  return snap.exists ? ({ accountId: snap.id, ...snap.data() } as Record<string, unknown>) : null;
}

/** `platform` is never changed here: the stored one decides how the username is
 *  cleaned, and a Reddit identity's history means nothing on another platform. */
export async function updateAccount(accountId: string, input: Partial<AccountInput>): Promise<void> {
  const ref = accounts().doc(accountId);
  const platform = accountPlatform((await ref.get()).data());
  await ref.update({ ...sanitize(input, platform), updatedAt: FieldValue.serverTimestamp() });
}

/** Store the forum standing read from the community. */
export async function saveForumStats(accountId: string, forumStats: Record<string, unknown>): Promise<void> {
  await accounts().doc(accountId).update({ forumStats, updatedAt: FieldValue.serverTimestamp() });
}

export async function deleteAccount(accountId: string): Promise<void> {
  await accounts().doc(accountId).delete();
}

/** Flag an account for a stats refresh. Deliberately does NOT dispatch a crawler:
 *  the agent captures Reddit-side stats the next time it naturally opens this
 *  profile (a post or, later, a warm-up session) and clears the flag. This keeps
 *  every stat read on the account's own session/IP, never a central crawler. */
export async function requestStatsRefresh(accountId: string, requestedBy: string): Promise<void> {
  await accounts().doc(accountId).update({
    statsRefreshRequestedAt: FieldValue.serverTimestamp(),
    statsRefreshRequestedBy: requestedBy,
    updatedAt: FieldValue.serverTimestamp(),
  });
}
