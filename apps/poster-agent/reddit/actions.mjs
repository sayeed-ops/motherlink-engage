// Layer B registry — action type → interaction primitive.
//
// The single place both the posting approach-flow AND (later) warm-up look up
// how to perform a step. The plan is data (a list of { type, params, ... }); the
// executor resolves each step.type here. Adding a warm-up action later = add its
// primitive and register it once; every flow gets it for free.
//
// Phase 2 registers the browse primitives alongside the terminal `post_comment`.
// An unknown step type is skipped by the executor, so a plan may safely carry
// actions a given agent build doesn't implement yet.

import { typeAndSubmitComment } from './comment-new.mjs';
import {
  openHome,
  openSubreddit,
  searchSubreddit,
  scrollFeed,
  findTarget,
  readPost,
  skimComments,
  upvotePost,
  upvoteComment,
} from './browse.mjs';
import { openFeedPost, openFeed, openPostSubreddit, searchKeyword, joinSubreddit } from './browse-warmup.mjs';

export const ACTIONS = {
  // browse (Phase 2) — also the warm-up vocabulary (Phase 4)
  open_home: openHome,
  search_subreddit: searchSubreddit,
  open_subreddit: openSubreddit,
  scroll_feed: scrollFeed,
  find_target: findTarget,
  read_post: readPost,
  skim_comments: skimComments,
  upvote_post: upvotePost,
  upvote_comment: upvoteComment,
  // warm-up: open SOMETHING from the feed. find_target is the posting twin, but
  // it hunts a KNOWN post id — useless when not caring which post is the point.
  open_feed_post: openFeedPost,
  // The nav rail (Home / Popular / News / Explore / All). News is a TOPIC FEED at
  // /news/, not r/news — faking it as a subreddit opened the wrong page.
  open_feed: openFeed,
  // The lateral move: from the post you are reading, through to its community.
  // Without it the only way out of a post is back to a top-level feed, which is
  // what made sessions read home -> post -> home -> post.
  open_post_subreddit: openPostSubreddit,
  // Reach a community by TOPIC rather than by name — searching a subreddit by
  // name assumes you already knew it existed, which is the thing a warm-up is
  // supposed to be establishing. Falls back to a name search if the topic does
  // not surface it.
  search_keyword: searchKeyword,
  // Join. Reads the button state FIRST and fails closed: the control toggles
  // Join <-> Joined, so an unverified click on an already-followed community
  // would LEAVE it.
  join_subreddit: joinSubreddit,
  // terminal
  post_comment: typeAndSubmitComment,
};

/** The subset a warm-up session may use. Posting-only actions must never leak
 *  into a plan whose whole point is that it posts nothing, and the composer in
 *  apps/web/src/modules/reddit/warmupWalk.ts is gated on the same list. This is
 *  the agent-side backstop for that. */
export const WARMUP_TYPES = new Set([
  'open_home',
  'open_subreddit',
  'search_subreddit',
  'search_keyword',
  'scroll_feed',
  'open_feed_post',
  'open_feed',
  'open_post_subreddit',
  'read_post',
  'skim_comments',
  'upvote_post',
  'upvote_comment',
  'join_subreddit',
]);

/**
 * The subset a KARMA COMMENT session may use — warm-up's vocabulary, plus the
 * two steps that make it about one specific post.
 *
 * A SEPARATE SET, and deliberately not a widened WARMUP_TYPES. That set is the
 * backstop that stops a warm-up ever posting, and it earns its keep precisely
 * by not having exceptions: adding `post_comment` to it would mean every
 * browsing session in the system was one corrupt job away from submitting
 * something, to buy nothing that a second set does not give.
 *
 * So the rule is one allowlist per job kind, chosen by the dispatcher:
 *   warmup  → WARMUP_TYPES   (cannot post, by construction)
 *   comment → COMMENT_TYPES  (browses, then posts exactly one thing)
 *   post    → the approach plan, unfiltered (a reviewed reply)
 */
export const COMMENT_TYPES = new Set([
  ...WARMUP_TYPES,
  // Hunt a KNOWN post rather than "something from the feed" — a karma comment is
  // about one thread that survived selection.
  'find_target',
  // The terminal step. This is the only line that separates this set from the
  // warm-up one, and it is why they are two sets.
  'post_comment',
]);

/** Which step types actually post something (terminal). Used by the executor to
 *  return their result and by the caller to know a job was completed. */
export const TERMINAL_TYPES = new Set(['post_comment']);
