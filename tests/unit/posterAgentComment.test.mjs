// The agent's half of a karma comment.
//
// The one assertion here that is really a policy, not a unit test:
//
//     WARMUP_TYPES must NOT contain post_comment.
//
// That set is the backstop that stops a warm-up browse ever submitting
// anything, and it earns its keep by having no exceptions. Comment karma needed
// a vocabulary that includes posting, and the tempting one-line version of that
// is to add `post_comment` to the set that already exists — which would leave
// every browsing session in the system one corrupt job away from posting. The
// test fails if anyone ever does it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { commentGate, nextCommentCounters, gate, DAY_MS } from '../../apps/poster-agent/agent-core.mjs';
import { WARMUP_TYPES, COMMENT_TYPES, TERMINAL_TYPES } from '../../apps/poster-agent/reddit/actions.mjs';

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
const HOUR = 3_600_000;
const ts = (ms) => ({ toMillis: () => ms });

const account = (over = {}) => ({
  status: 'active',
  dailyCap: 5,
  minIntervalMinutes: 30,
  postCountToday: 0,
  postCountResetAt: ts(NOW - 2 * HOUR),
  lastPostAt: null,
  commentKarma: { dailyCap: 3, minIntervalMinutes: 90, combinedDailyCap: 6 },
  commentCountToday: 0,
  commentCountResetAt: ts(NOW - 2 * HOUR),
  lastCommentAt: null,
  ...over,
});

// --- the allowlists ---------------------------------------------------------

test('a warm-up still cannot post, and that is the whole point of the second set', () => {
  assert.equal(WARMUP_TYPES.has('post_comment'), false, 'WARMUP_TYPES must never admit post_comment');
  assert.equal(WARMUP_TYPES.has('find_target'), false, 'a browse does not hunt one known post');
});

test('the comment vocabulary is the warm-up one plus exactly what a comment needs', () => {
  for (const type of WARMUP_TYPES) {
    assert.ok(COMMENT_TYPES.has(type), `${type} should be usable by a comment session`);
  }
  assert.ok(COMMENT_TYPES.has('post_comment'));
  assert.ok(COMMENT_TYPES.has('find_target'));
  assert.equal(COMMENT_TYPES.size, WARMUP_TYPES.size + 2, 'nothing else should have crept in');
  assert.ok(TERMINAL_TYPES.has('post_comment'));
});

// --- the agent-side rails ---------------------------------------------------

test('a comment is gated on the comment counters, not the posting ones', () => {
  // Posting cap fully spent, comment cap untouched: the comment may still go.
  const busy = account({ postCountToday: 5, lastPostAt: ts(NOW - 5 * 60_000) });
  assert.equal(gate(busy, NOW).ok, false, 'the posting gate should refuse');
  assert.equal(commentGate(busy, NOW).ok, true, 'the comment gate reads its own counters');
});

test('the combined ceiling is the one place the two meet', () => {
  const r = commentGate(account({ postCountToday: 6 }), NOW);
  assert.equal(r.ok, false);
  assert.equal(r.hard, true);
  assert.match(r.reason, /Combined ceiling/);
});

test('a full comment cap is hard, a too-soon comment is soft', () => {
  // Hard fails the job; soft defers it, because one will never become true and
  // the other becomes true by waiting.
  const capped = commentGate(account({ commentCountToday: 3 }), NOW);
  assert.equal(capped.hard, true);

  const soon = commentGate(account({ lastCommentAt: ts(NOW - 10 * 60_000) }), NOW);
  assert.equal(soon.ok, false);
  assert.equal(soon.hard, false);
  assert.match(soon.reason, /interval/i);
});

test('status still stops everything', () => {
  for (const status of ['banned', 'flagged']) {
    const r = commentGate(account({ status }), NOW);
    assert.equal(r.ok, false);
    assert.equal(r.hard, true);
  }
});

test('an account with no comment settings gets the defaults rather than zero caps', () => {
  // Every account predates this feature. A missing `commentKarma` must not read
  // as "cap of 0" — that would look like a rail and be a bug.
  const r = commentGate(account({ commentKarma: undefined }), NOW);
  assert.equal(r.ok, true, r.reason);
});

test('the counter advance rolls its own window', () => {
  const Timestamp = { fromMillis: (ms) => ts(ms) };
  const FieldValue = { serverTimestamp: () => 'SERVER_TS' };

  const open = nextCommentCounters(account({ commentCountToday: 2 }), NOW, Timestamp, FieldValue);
  assert.equal(open.commentCountToday, 3);
  assert.equal(open.commentCountResetAt.toMillis(), NOW - 2 * HOUR);
  assert.equal(open.lastCommentAt.toMillis(), NOW);

  const rolled = nextCommentCounters(
    account({ commentCountToday: 9, commentCountResetAt: ts(NOW - DAY_MS - HOUR) }),
    NOW,
    Timestamp,
    FieldValue,
  );
  assert.equal(rolled.commentCountToday, 1);
  assert.equal(rolled.commentCountResetAt.toMillis(), NOW);
});
