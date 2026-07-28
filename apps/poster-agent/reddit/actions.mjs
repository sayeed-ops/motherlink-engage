// Layer B registry — action type → interaction primitive.
//
// The single place both the posting approach-flow AND (later) warm-up look up
// how to perform a step. The plan is data (a list of { type, params, ... }); the
// executor resolves each step.type here. Adding a warm-up action later = add its
// primitive and register it once; every flow gets it for free.
//
// Phase 1 registers only the terminal `post_comment` (new reddit). Phase 2 adds
// the browse primitives (search_keyword, open_subreddit, scroll_feed, open_post,
// read_dwell, expand_comments, find_target, …).

import { typeAndSubmitComment } from './comment-new.mjs';

export const ACTIONS = {
  post_comment: typeAndSubmitComment,
  // Phase 2 (browse primitives) — registered here:
  // search_keyword, open_subreddit, scroll_feed, open_post, read_dwell,
  // expand_comments, find_target, upvote_post, upvote_comment, idle
};

/** Which step types actually post something (terminal). Used by the executor to
 *  return their result and by the caller to know a job was completed. */
export const TERMINAL_TYPES = new Set(['post_comment']);
