// Whether an approved Shopify draft may be queued for the agent to post.
//
// PURE — the route and the screen both ask it, so the button and the server
// can never disagree about why something is not postable.
//
// ════════════════════════════════════════════════════════════════════════════
// THE CHECKS, IN THE ORDER A PERSON WOULD FIX THEM
//
//   1. the draft: approved, has text, long enough for the forum, no forbidden
//      phrase (a hit is shown, never silently posted);
//   2. the account: a Shopify Community identity, with a profile and a
//      username, not banned or flagged, inside its daily cap and interval;
//   3. the AGENT: it must be one that knows Shopify jobs exist.
//
// ⚠️ THE THIRD IS NOT A NICETY. An agent from before Shopify posting has no
// platform check at all: it claims the oldest queued job and drives it down the
// Reddit path. So a Shopify job is only queued when the agent's heartbeat lists
// 'shopify' — AND that list was written by the process running now. Heartbeats
// MERGE into one document, and an older agent never touches the field, so a
// stale list from a newer run could otherwise vouch for an old process. The
// newer agent stamps `platformsPid` with its own pid; a mismatch means "don't
// know what is running", which is a no.
// ════════════════════════════════════════════════════════════════════════════

import { accountPostGate } from '@/modules/reddit/accountGate';
import type { RedditAccountStatus } from '@/modules/reddit/types';
import { accountPlatform } from '@/modules/accounts/platform';
import { findForbidden } from './client';

export const MIN_REPLY_CHARS = 20;

export interface DraftForPosting {
  status: string;
  text: string;
  forbiddenHits?: string[];
}

export interface AccountForPosting {
  platform?: unknown;
  status?: unknown;
  username?: unknown;
  adsPowerProfileId?: unknown;
  dailyCap?: unknown;
  minIntervalMinutes?: unknown;
  postCountToday?: unknown;
  postCountResetAtMs?: number;
  lastPostAtMs?: number;
}

export interface AgentForPosting {
  platforms?: unknown;
  pid?: unknown;
  platformsPid?: unknown;
}

/** Why this draft cannot be queued at all, whichever account is picked. */
export function draftRefusal(draft: DraftForPosting, forbiddenPhrases: readonly string[]): string | null {
  if (draft.status === 'posted') return 'This reply has already been posted.';
  if (draft.status !== 'approved') return 'Approve the draft before posting it.';
  const text = String(draft.text || '').trim();
  if (!text) return 'This draft is empty — nothing to post.';
  if (text.length < MIN_REPLY_CHARS) return `The forum refuses replies under ${MIN_REPLY_CHARS} characters.`;
  // Re-checked against the CURRENT list, not only the hits stored at writing time:
  // a phrase forbidden since the draft was written must still stop it.
  const hits = [...new Set([...(draft.forbiddenHits ?? []), ...findForbidden(text, forbiddenPhrases)])];
  if (hits.length) return `Contains a forbidden phrase (${hits.join(', ')}). Edit it before posting.`;
  return null;
}

/** Why this account cannot post this now. */
export function accountRefusal(account: AccountForPosting | null, nowMs: number): string | null {
  if (!account) return 'No such account.';
  if (accountPlatform(account) !== 'shopify') return 'That is not a Shopify Community account.';
  if (!String(account.adsPowerProfileId || '').trim()) return 'That account has no AdsPower profile ID.';
  if (!String(account.username || '').trim()) return 'That account has no forum username, so the agent cannot verify it.';
  const gate = accountPostGate(
    {
      status: (account.status as RedditAccountStatus) ?? 'warming',
      dailyCap: Number(account.dailyCap ?? 0),
      minIntervalMinutes: Number(account.minIntervalMinutes ?? 0),
      postCountToday: Number(account.postCountToday ?? 0),
      postCountResetAtMs: account.postCountResetAtMs ?? 0,
      lastPostAtMs: account.lastPostAtMs ?? 0,
    },
    nowMs,
  );
  return gate.ok ? null : (gate.reason ?? 'That account cannot post right now.');
}

/** Can the running agent be trusted with a Shopify job? */
export function agentRefusal(agent: AgentForPosting | null): string | null {
  if (!agent) return 'No posting agent has ever connected.';
  const platforms = Array.isArray(agent.platforms) ? agent.platforms : [];
  const current = agent.pid !== undefined && agent.pid === agent.platformsPid;
  if (!platforms.includes('shopify') || !current) {
    return 'The posting agent is running a version that cannot post to the Shopify Community. Restart it from the Motherlink Agent panel, then try again.';
  }
  return null;
}
