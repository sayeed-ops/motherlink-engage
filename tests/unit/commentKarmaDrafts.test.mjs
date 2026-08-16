// The scan record and the per-account settings.
//
// Two rules with teeth:
//   - APPROVED IS NOT POSTABLE. A comment is written against a snapshot of a
//     thread, and threads move. Phase 5 must re-ask at enqueue time rather than
//     trusting an approval made two hours ago.
//   - A status change is a race — two operators, or an operator and the auto
//     switch — so the transition is a function that refuses, not an update that
//     overwrites.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  draftFreshness,
  isPostable,
  isReviewable,
  nextStatus,
  normalizeDraft,
  SKIP_STAGE_LABEL,
} from '../../apps/web/src/modules/reddit/commentKarma/drafts.ts';
import {
  commentPairs,
  DEFAULT_COMMENT_SETTINGS,
  normalizeCommentSettings,
  scanReadiness,
} from '../../apps/web/src/modules/reddit/commentKarma/settings.ts';
import { DEFAULT_LIMITS } from '../../apps/web/src/modules/reddit/commentKarma/select.ts';

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
const HOUR = 3_600_000;

const thread = (ageHours) => ({
  redditPostId: 't3_x',
  subreddit: 'askreddit',
  title: 'what did it cost you',
  permalink: '/r/askreddit/comments/x/',
  threadUrl: 'https://www.reddit.com/r/askreddit/comments/x/',
  postCreatedAtMs: NOW - ageHours * HOUR,
  score: 40,
  numComments: 12,
  fetchedAtMs: NOW - HOUR,
});

// --- freshness --------------------------------------------------------------

test('a draft goes stale on the same window that chose the thread', () => {
  assert.equal(draftFreshness(thread(2), NOW).stale, false);
  assert.equal(draftFreshness(thread(DEFAULT_LIMITS.maxAgeHours + 1), NOW).stale, true);
  // No thread at all is stale rather than fresh — failing closed.
  assert.equal(draftFreshness(null, NOW).stale, true);
});

test('approved is not the same fact as postable', () => {
  const record = { status: 'approved', text: 'took me about six months', thread: thread(2) };
  assert.equal(isPostable(record, NOW).ok, true);

  // The same approval, two hours past the window.
  const late = { ...record, thread: thread(DEFAULT_LIMITS.maxAgeHours + 2) };
  const verdict = isPostable(late, NOW);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /thread is \d+h old/);

  assert.equal(isPostable({ ...record, status: 'pending' }, NOW).ok, false);
  assert.equal(isPostable({ ...record, text: '  ' }, NOW).ok, false);
  assert.equal(isPostable({ ...record, thread: null }, NOW).ok, false);
});

// --- the transition ---------------------------------------------------------

test('only a pending draft can be reviewed, and only once', () => {
  assert.equal(nextStatus('pending', 'approve'), 'approved');
  assert.equal(nextStatus('pending', 'reject'), 'rejected');
  // The loser of a race gets a refusal rather than overwriting the winner.
  for (const status of ['approved', 'rejected', 'skipped', 'posted', 'failed']) {
    assert.equal(nextStatus(status, 'approve'), null, `${status} must not be re-approvable`);
    assert.equal(nextStatus(status, 'reject'), null);
  }
  assert.equal(isReviewable('pending'), true);
  assert.equal(isReviewable('approved'), false);
});

// --- normalising ------------------------------------------------------------

test('a malformed record renders instead of throwing', () => {
  // The panel is the only window onto what this system is doing, and one bad
  // row must not hide the other forty.
  const r = normalizeDraft('d1', { status: 'nonsense', words: 'lots', rejected: 'no', trace: [1, 'ok'] });
  assert.equal(r.status, 'skipped');
  assert.equal(r.words, 0);
  assert.deepEqual(r.rejected, []);
  assert.deepEqual(r.trace, ['ok']);
  assert.equal(r.text, null);
  assert.equal(normalizeDraft('d1', null), null);
});

test('every skip stage has a label, so the panel never shows a raw enum', () => {
  const r = normalizeDraft('d1', { status: 'skipped', skipStage: 'critic', skipReason: 'none good enough' });
  assert.equal(SKIP_STAGE_LABEL[r.skipStage], 'None of them was good enough');
  // An unknown stage is dropped rather than rendered as itself.
  assert.equal(normalizeDraft('d2', { skipStage: 'invented' }).skipStage, null);
});

// --- settings ---------------------------------------------------------------

test('an account that predates the feature reads as off', () => {
  // Absent means OFF for both switches — the opposite of the canUseSharedKeys
  // convention, because that one removes a permission and this one starts
  // spending.
  const s = normalizeCommentSettings(undefined);
  assert.equal(s.enabled, false);
  assert.equal(s.autoPost, false);
  assert.deepEqual(s, DEFAULT_COMMENT_SETTINGS);
  assert.equal(normalizeCommentSettings({ enabled: 'yes' }).enabled, false);
});

test('numbers are clamped rather than trusted', () => {
  const s = normalizeCommentSettings({ dailyCap: 900, minIntervalMinutes: 0, maxThreadsPerScan: 50 });
  assert.equal(s.dailyCap, 20);
  assert.equal(s.minIntervalMinutes, 15);
  // Every thread read is a billed call, so this one especially.
  assert.equal(s.maxThreadsPerScan, 8);
  assert.equal(normalizeCommentSettings({ dailyCap: 'lots' }).dailyCap, DEFAULT_COMMENT_SETTINGS.dailyCap);
});

test('the persona and the banned terms are bounded and de-duplicated', () => {
  const s = normalizeCommentSettings({
    persona: { topics: ['budgeting', 'Budgeting', '  ', 'renting'], situation: ' renting in Manchester ', neverClaims: ['a doctor'] },
    bannedTerms: ['Motherlink', 'motherlink'],
  });
  assert.deepEqual(s.persona.topics, ['budgeting', 'renting']);
  assert.equal(s.persona.situation, 'renting in Manchester');
  assert.deepEqual(s.bannedTerms, ['Motherlink']);
});

test('readiness says WHICH thing is missing, because the fixes are on different tabs', () => {
  const withKeywords = [{ subreddit: 'askreddit', keywords: ['cost'] }];
  assert.match(scanReadiness(normalizeCommentSettings({}), withKeywords).reason, /switched off/);

  const on = normalizeCommentSettings({ enabled: true });
  assert.match(scanReadiness(on, []).reason, /tagged Comment/);
  // Tagged but unsearchable is a different problem with a different fix, and
  // saying "nowhere to look" there would send someone to the wrong control.
  assert.match(scanReadiness(on, [{ subreddit: 'askreddit', keywords: [] }]).reason, /no keywords/);
  assert.equal(scanReadiness(on, withKeywords).ok, true);
});

test('a community with no keywords of its own falls back to the account pool', () => {
  // The same rule the browsing walk follows. Demanding per-community keywords
  // made an account with ten perfectly good global ones look broken.
  const communities = [
    { name: 'budget', roles: ['browse', 'comment'], keywords: ['daily budget method'] },
    { name: 'frugal', roles: ['browse', 'comment'] },
    { name: 'ynab', roles: ['browse'], keywords: ['ynab'] },
  ];
  const pairs = commentPairs(communities, ['always broke before payday', 'cant stick to a budget']);

  assert.deepEqual(pairs.map((p) => p.subreddit), ['budget', 'frugal'], 'only Comment-tagged communities');
  // A pairing beats the pool: it is the only way the system knows one query
  // plausibly reaches one community.
  assert.deepEqual(pairs[0].keywords, ['daily budget method']);
  assert.equal(pairs[1].keywords.length, 2);

  // And with no pool either, there is genuinely nowhere to search.
  assert.equal(commentPairs(communities, [])[1].keywords.length, 0);
  assert.equal(scanReadiness(normalizeCommentSettings({ enabled: true }), commentPairs(communities, [])).ok, true,
    'one community still has its own keywords, so a scan is possible');
});
