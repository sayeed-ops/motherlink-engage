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
  // terminal
  post_comment: typeAndSubmitComment,
  // Still to come: expand_comments, idle
};

/** Which step types actually post something (terminal). Used by the executor to
 *  return their result and by the caller to know a job was completed. */
export const TERMINAL_TYPES = new Set(['post_comment']);
