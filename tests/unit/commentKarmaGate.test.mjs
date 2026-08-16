// The comment rails.
//
// The property that matters most here is a NEGATIVE one: commenting must never
// spend a reply slot. `postCountToday` is read for the combined ceiling and
// never written, and a comment refused by its own cap must leave the posting
// budget exactly as it found it — otherwise a queued reply sits behind "daily
// cap reached" having been throttled by karma building, and nothing in the UI
// would say so.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  commentGate,
  commentsInSubredditToday,
  nextCommentCounters,
} from '../../apps/web/src/modules/reddit/commentKarma/gate.ts';
import { DEFAULT_COMMENT_SETTINGS } from '../../apps/web/src/modules/reddit/commentKarma/settings.ts';
import { accountPostGate } from '../../apps/web/src/modules/reddit/accountGate.ts';

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
const HOUR = 3_600_000;

const input = (over = {}) => ({
  status: 'active',
  settings: { ...DEFAULT_COMMENT_SETTINGS, enabled: true },
  commentCountToday: 0,
  commentCountResetAtMs: NOW - 2 * HOUR,
  lastCommentAtMs: 0,
  postCountToday: 0,
  postCountResetAtMs: NOW - 2 * HOUR,
  history: [],
  subreddit: 'askreddit',
  ...over,
});

test('a fresh account may comment', () => {
  const r = commentGate(input(), NOW);
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.combinedToday, 0);
});

test('the comment cap is its own, and posting is untouched by it', () => {
  const at = input({ commentCountToday: DEFAULT_COMMENT_SETTINGS.dailyCap });
  assert.equal(commentGate(at, NOW).ok, false);

  // The same account, asked the POSTING question: still free. This is the whole
  // reason the counters are separate.
  const posting = accountPostGate(
    {
      status: 'active',
      dailyCap: 5,
      minIntervalMinutes: 30,
      postCountToday: 0,
      postCountResetAtMs: NOW - 2 * HOUR,
      lastPostAtMs: 0,
    },
    NOW,
  );
  assert.equal(posting.ok, true);
  assert.equal(posting.remainingToday, 5);
});

test('the combined ceiling reads replies without spending them', () => {
  // Five replies today, no comments: under the comment cap, over the combined.
  const r = commentGate(input({ postCountToday: 6 }), NOW);
  assert.equal(r.ok, false);
  assert.match(r.reason, /Combined ceiling/);
  assert.equal(r.combinedToday, 6);
});

test('an expired window is not counted, on either side', () => {
  const stale = input({
    commentCountToday: 9,
    commentCountResetAtMs: NOW - 30 * HOUR,
    postCountToday: 9,
    postCountResetAtMs: NOW - 30 * HOUR,
  });
  const r = commentGate(stale, NOW);
  assert.equal(r.combinedToday, 0);
  assert.equal(r.ok, true, r.reason);
});

test('the per-subreddit rail counts only that subreddit, and only today', () => {
  const history = [
    { postedAtMs: NOW - 3 * HOUR, words: 20, subreddit: 'AskReddit', opening: 'a' },
    { postedAtMs: NOW - 40 * HOUR, words: 20, subreddit: 'askreddit', opening: 'b' },
    { postedAtMs: NOW - 2 * HOUR, words: 20, subreddit: 'cooking', opening: 'c' },
  ];
  // Case-insensitive, since we store names lowercased and Reddit does not.
  assert.equal(commentsInSubredditToday(history, 'askreddit', NOW), 1);
  assert.equal(commentsInSubredditToday(history, 'cooking', NOW), 1);

  const blocked = commentGate(input({ history, subreddit: 'askreddit' }), NOW);
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /Already commented 1 time\(s\) in r\/askreddit/);

  // Somewhere else is fine — the rail is about one room's regulars noticing.
  assert.equal(commentGate(input({ history, subreddit: 'budgetuk' }), NOW).ok, true);
});

test('status and interval come from the one gate that already exists', () => {
  assert.equal(commentGate(input({ status: 'banned' }), NOW).ok, false);
  assert.equal(commentGate(input({ status: 'flagged' }), NOW).ok, false);
  const soon = commentGate(input({ lastCommentAtMs: NOW - 10 * 60_000 }), NOW);
  assert.equal(soon.ok, false);
  assert.match(soon.reason, /Too soon/);
});

test('the counter advance rolls the window rather than accumulating forever', () => {
  const fresh = nextCommentCounters({ commentCountToday: 2, commentCountResetAtMs: NOW - 2 * HOUR }, NOW);
  assert.equal(fresh.commentCountToday, 3);
  assert.equal(fresh.commentCountResetAtMs, NOW - 2 * HOUR, 'an open window keeps its start');
  assert.equal(fresh.lastCommentAtMs, NOW);

  const rolled = nextCommentCounters({ commentCountToday: 9, commentCountResetAtMs: NOW - 30 * HOUR }, NOW);
  assert.equal(rolled.commentCountToday, 1);
  assert.equal(rolled.commentCountResetAtMs, NOW);
});
