// Which communities an account has actually joined.
//
// PURE — no 'server-only', no Firestore. The Communities tab, the warm-up run
// route and the comment-karma scan all read membership through here, so they
// cannot disagree about it.
//
// ════════════════════════════════════════════════════════════════════════════
// WHAT WENT WRONG, AND WHY THERE ARE THREE LISTS NOW
//
// There used to be one list, `followedSubreddits`, fed from three places — and
// one of them was wrong. After a warm-up session the agent read every /r/ link
// in Reddit's left sidebar and recorded all of them as joined. That sidebar has
// a RECENT section listing the communities the account merely visited, and
// warm-up browsing visits communities all day. So communities nobody had joined
// were recorded as joined, the Communities tab hid its "already joined?" button
// for them, and follow sessions skipped them for good. The list was additive
// only, so nothing ever corrected it.
//
// The three sources are now kept apart, so one of them being wrong can be seen
// and undone without losing the other two:
//
//   joinedConfirmed  the agent clicked Join and re-read the button afterwards
//   joinedManual     the operator said "I joined this one myself"
//   joinedOnReddit   the account's own COMMUNITIES list, read from the sidebar's
//                    communities section and nothing else — a snapshot, replaced
//                    on each read, so a community left by hand drops out of it
//
// `followedSubreddits` is no longer read by anything. It cannot be repaired —
// it never recorded which source an entry came from — so it is left where it
// is and ignored.
// ════════════════════════════════════════════════════════════════════════════

import { normalizeSubredditList } from './subreddits';

export type JoinedSource = 'confirmed' | 'manual' | 'reddit';

/** Every community the account is in, by any of the three sources. */
export function joinedCommunities(account: Record<string, unknown> | null | undefined): string[] {
  if (!account) return [];
  return normalizeSubredditList([
    ...normalizeSubredditList(account.joinedOnReddit),
    ...normalizeSubredditList(account.joinedConfirmed),
    ...normalizeSubredditList(account.joinedManual),
  ]);
}

/** How we know, per community — for the tab to say so. */
export function joinedSources(account: Record<string, unknown> | null | undefined): Record<string, JoinedSource[]> {
  const out: Record<string, JoinedSource[]> = {};
  if (!account) return out;
  const add = (list: unknown, source: JoinedSource) => {
    for (const name of normalizeSubredditList(list)) (out[name] ||= []).push(source);
  };
  add(account.joinedOnReddit, 'reddit');
  add(account.joinedConfirmed, 'confirmed');
  add(account.joinedManual, 'manual');
  return out;
}

export const JOINED_SOURCE_LABEL: Record<JoinedSource, string> = {
  reddit: "on the account's Communities list on Reddit",
  confirmed: 'joined by a follow session',
  manual: 'marked by you',
};

/** Has the agent ever read this account's Communities list? Until it has, an
 *  empty result means "not looked yet", not "follows nothing". */
export function hasJoinedSnapshot(account: Record<string, unknown> | null | undefined): boolean {
  return !!account && account.joinedOnRedditAt != null;
}
