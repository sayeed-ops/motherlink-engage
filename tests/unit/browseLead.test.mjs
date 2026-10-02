// The browse lead: the short browsing session a reply or a karma comment runs
// before it goes looking for its thread.
//
// What these tests protect:
//   - A lead can never post, never join, and never wanders into the community
//     it is about to comment in. Those hold in the composer AND in the agent's
//     own allowlist, because the composer is the one that can be wrong.
//   - When a lead runs, the approach starts at the search bar. Landing on Home a
//     second time is the fixed opening the lead exists to replace.
//   - It is shorter than a warm-up session, and it is sometimes absent.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LEAD_SESSION_LENGTH,
  LEAD_SKIP_CHANCE,
  RECENT_WARMUP_MS,
  composeBrowseLead,
  normalizeBrowsePlan,
  normalizeLeadSkip,
} from '../../apps/web/src/modules/reddit/browseLead.ts';
import { composeApproachPlan, describeApproachStep, describeApproachOutcome } from '../../apps/web/src/modules/reddit/approach.ts';
import { LEAD_TYPES, WARMUP_TYPES } from '../../apps/poster-agent/reddit/actions.mjs';
import { titleQuery } from '../../apps/poster-agent/reddit/browse.mjs';

const NOW = Date.UTC(2026, 9, 2, 12, 0, 0);
const DAY = 86_400_000;

const ACCOUNT = {
  warmupStartedAt: { toMillis: () => NOW - 20 * DAY },
  warmupSessionsCompleted: 60,
  warmupCommunities: [
    { name: 'sportsbetting', roles: ['browse', 'follow'], keywords: ['betting tips'] },
    { name: 'onlinegambling', roles: ['browse', 'follow'], keywords: ['casino bonus'] },
    { name: 'stake', roles: ['browse', 'follow'], keywords: ['stake'] },
  ],
  warmupKeywords: ['bankroll', 'parlays'],
};

const leads = (n, over = {}) =>
  Array.from({ length: n }, (_, i) =>
    composeBrowseLead({ account: ACCOUNT, targetSubreddit: 'Stake', nowMs: NOW, seed: 1000 + i, skipRoll: 1, ...over }),
  );

test('a lead never posts, never joins and never hunts a specific post', () => {
  for (const lead of leads(300)) {
    assert.ok(lead.plan.length > 0);
    for (const step of lead.plan) {
      assert.ok(LEAD_TYPES.has(step.type), step.type);
      assert.notEqual(step.type, 'join_subreddit');
      assert.notEqual(step.type, 'post_comment');
      assert.notEqual(step.type, 'find_target');
    }
  }
});

test('a lead never opens or searches for the community it is about to post in', () => {
  for (const lead of leads(300)) {
    for (const step of lead.plan) {
      for (const v of Object.values(step.params)) {
        if (typeof v === 'string') assert.notEqual(v.toLowerCase(), 'stake', `${step.type} is aimed at the target community`);
      }
    }
  }
  // The other communities are still fair game — it is the target that is held out.
  const seen = new Set(leads(300).flatMap((l) => l.plan.map((s) => String(s.params.subreddit ?? ''))));
  assert.ok(seen.has('sportsbetting') || seen.has('onlinegambling'));
});

test('a lead is shorter than a warm-up session', () => {
  for (const lead of leads(300)) {
    assert.ok(lead.plan.length <= LEAD_SESSION_LENGTH.stepMax + 4, `${lead.plan.length} steps`);
    // The estimate overshoots its budget by at most the step that crossed it.
    assert.ok(lead.estimatedSec <= LEAD_SESSION_LENGTH.wallMaxSec + 150, `${lead.estimatedSec}s`);
  }
});

test('the same seed composes the same lead', () => {
  const [a] = leads(1);
  const [b] = leads(1);
  assert.deepEqual(a, b);
});

test('an account that has just finished a warm-up session does not browse again', () => {
  const [lead] = leads(1, { lastWarmupAtMs: NOW - 5 * 60_000 });
  assert.deepEqual([lead.plan, lead.skipped], [[], 'recent-warmup']);
  // An older session does not count.
  const [later] = leads(1, { lastWarmupAtMs: NOW - RECENT_WARMUP_MS - 1 });
  assert.equal(later.skipped, '');
  assert.ok(later.plan.length > 0);
});

test('a share of jobs skip the lead by chance', () => {
  assert.equal(leads(1, { skipRoll: LEAD_SKIP_CHANCE - 0.001 })[0].skipped, 'chance');
  assert.equal(leads(1, { skipRoll: LEAD_SKIP_CHANCE })[0].skipped, '');
});

test('an account with no warm-up setup still gets a lead', () => {
  const lead = composeBrowseLead({ account: {}, targetSubreddit: 'stake', nowMs: NOW, seed: 7, skipRoll: 1 });
  assert.ok(lead.plan.length > 0);
  assert.equal(lead.day, 1);
});

// --- the approach that follows ------------------------------------------------

const APPROACH = { subreddit: 'stake', redditPostId: 'abc123', threadUrl: 'https://www.reddit.com/r/stake/comments/abc123/x/' };

test('after a lead the approach starts at the search bar', () => {
  for (let i = 0; i < 50; i++) {
    const plan = composeApproachPlan({ ...APPROACH, arrivesBrowsing: true });
    assert.equal(plan[0].type, 'search_subreddit');
    assert.ok(!plan.some((s) => s.type === 'open_home'));
    assert.equal(plan.at(-1).type, 'post_comment');
  }
});

test('with no lead the approach opens on the home feed, as it always did', () => {
  const plan = composeApproachPlan(APPROACH);
  assert.deepEqual(plan.slice(0, 4).map((s) => s.type), ['open_home', 'search_subreddit', 'scroll_feed', 'find_target']);
});

test('the hunt searches for the title before it opens the thread directly', () => {
  const hunt = composeApproachPlan(APPROACH).find((s) => s.type === 'find_target');
  assert.equal(hunt.params.searchTitle, true);
  assert.match(describeApproachStep(hunt), /then search the community for its title/);
  assert.match(describeApproachOutcome({ type: 'find_target', ok: true, via: 'title-search' }), /searching the community/);
});

test('a title is searched the way a person would type it', () => {
  assert.equal(titleQuery('Started with $1, now at $93 — how do I keep going without becoming a degenerate gambler? Any advice?'), 'Started with 1 now at 93 how do');
  assert.equal(titleQuery("Stake.us is DIRTY for this game"), 'Stake us is DIRTY for this game');
  assert.equal(titleQuery(''), '');
  assert.equal(titleQuery(undefined), '');
});

// --- the agent's own backstop -------------------------------------------------

test('the lead allowlist is warm-up minus joining, and cannot post', () => {
  assert.ok(!LEAD_TYPES.has('join_subreddit'));
  assert.ok(!LEAD_TYPES.has('post_comment'));
  assert.ok(!LEAD_TYPES.has('find_target'));
  assert.equal(LEAD_TYPES.size, WARMUP_TYPES.size - 1);
  // Not a widened warm-up set: that one still joins, and still cannot post.
  assert.ok(WARMUP_TYPES.has('join_subreddit'));
  assert.ok(!WARMUP_TYPES.has('post_comment'));
});

// --- reading it back ----------------------------------------------------------

test('a plan read back from a job drops anything that is not a browsing step', () => {
  const plan = normalizeBrowsePlan([
    { type: 'open_feed', params: { feed: 'home' }, gapAfterSec: 2, jitterPct: 0 },
    { type: 'post_comment', params: {} },
    { type: 'find_target', params: {} },
    'nonsense',
    null,
  ]);
  assert.deepEqual(plan.map((s) => s.type), ['open_feed']);
  assert.deepEqual(normalizeBrowsePlan(undefined), []);
  assert.equal(normalizeLeadSkip({ skipped: 'recent-warmup' }), 'recent-warmup');
  assert.equal(normalizeLeadSkip({ skipped: 'whatever' }), '');
  assert.equal(normalizeLeadSkip(undefined), '');
});
