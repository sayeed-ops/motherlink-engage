// Which subreddits a comment scan may look in, and what it may search them for.
//
// THE REDDIT HALF OF THE SETTINGS FILE. Everything else that was in
// commentKarma/settings.ts is platform-neutral and now lives at
// @/modules/forum/reply/settings; this is the one function that was not,
// because it reads the account's tagged community list — a Reddit concept
// (`WarmupCommunity`, roles browse/follow/comment/post) that Covers has no
// equivalent of. It stayed behind rather than dragging `../subreddits` into the
// shared core, which would have made "platform-neutral" untrue on its first day.
//
// PURE, like the file it came from — no 'server-only' — because both the panel
// (deciding whether the scan button is usable) and the server (running the scan)
// call it, and they must not be able to disagree.

import type { CommunityKeywords } from '@/modules/forum/reply/settings';
import { communitiesForRole, keywordsByCommunity, type WarmupCommunity } from '../subreddits';

/**
 * Where a scan may look, and what it may search for.
 *
 * PER-COMMUNITY KEYWORDS FIRST, THE ACCOUNT'S POOL AS THE FALLBACK — the same
 * rule the browsing walk already follows, and stated in the community model
 * itself: "an unpaired community falls back to the account's global keyword
 * pool". Comment karma originally demanded per-community keywords and refused
 * without them, which made an account with ten perfectly good global keywords
 * look like a broken feature.
 *
 * A pairing is still better than the pool. It is the only way the system can
 * know that one query plausibly reaches one community, so a global keyword can
 * genuinely surface nothing — that is a wasted search, not a wasted comment,
 * and the screen rejects the results for free.
 *
 * ONE IMPLEMENTATION, TWO CALL SITES: the panel decides whether the button is
 * usable from this, and the server scans from it. They cannot disagree.
 */
export function commentPairs(
  communities: WarmupCommunity[],
  accountKeywords: string[],
): CommunityKeywords[] {
  const byCommunity = keywordsByCommunity(communities);
  return communitiesForRole(communities, 'comment').map((subreddit) => ({
    subreddit,
    keywords: byCommunity[subreddit]?.length ? byCommunity[subreddit] : accountKeywords,
  }));
}
