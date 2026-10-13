// The routes a comment can arrive by.
//
// What these tests protect:
//   - The old flow is still there, untouched, and is still what a job gets when
//     nothing else is known: home, search, scroll, find, read, comment.
//   - The new ways in are ADDITIONS. They are only planned when they could be
//     true (in Recent, joined, a lead to be away during), and every one of them
//     carries the search it falls back to.
//   - A first visit can never post, and a job never posts twice.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ENTRY_WEIGHTS,
  FIRST_VISIT_APPROACH_TYPES,
  composeApproachPlan,
  composeCommentRoute,
  describeApproachOutcome,
  describeApproachStep,
  approachStepCaveat,
  normalizeRouteShape,
} from '../../apps/web/src/modules/reddit/approach.ts';
import { routeHints } from '../../apps/web/src/modules/reddit/joined.ts';
import { ACTIONS, COMMENT_TYPES, FIRST_VISIT_TYPES, LEAD_TYPES, WARMUP_TYPES } from '../../apps/poster-agent/reddit/actions.mjs';

const TARGET = { subreddit: 'stake', redditPostId: '1abc234', threadUrl: 'https://www.reddit.com/r/stake/comments/1abc234/x/' };
const EVERYTHING = { ...TARGET, arrivesBrowsing: true, hasLead: true, joined: true, inRecent: true };
const types = (plan) => plan.map((s) => s.type);
const many = (n, input) => Array.from({ length: n }, () => composeCommentRoute(input));
const entryOf = (plan) => plan.find((s) => s.type === 'search_subreddit' || s.type === 'enter_subreddit');

test('with nothing known, a job is the flow it always was', () => {
  for (const route of many(200, TARGET)) {
    assert.equal(route.shape, 'single');
    assert.deepEqual(route.firstVisit, []);
    assert.deepEqual(types(route.approach).slice(0, 5), ['open_home', 'search_subreddit', 'scroll_feed', 'find_target', 'read_post']);
    assert.equal(route.approach.at(-1).type, 'post_comment');
  }
});

test('the old composer still composes the old plan', () => {
  assert.deepEqual(types(composeApproachPlan(TARGET)).slice(0, 4), ['open_home', 'search_subreddit', 'scroll_feed', 'find_target']);
});

test('search is still the commonest way in, and one visit the commonest shape', () => {
  const routes = many(4000, EVERYTHING);
  const single = routes.filter((r) => r.shape === 'single');
  assert.ok(single.length > routes.length / 2, `single ${single.length}`);
  const searched = single.filter((r) => entryOf(r.approach).type === 'search_subreddit').length;
  for (const via of ['recent', 'joined', 'feed']) {
    const n = single.filter((r) => entryOf(r.approach).params.via === via).length;
    assert.ok(n > 0, `${via} never rolled`);
    assert.ok(n < searched, `${via} ${n} vs search ${searched}`);
  }
  assert.ok(routes.some((r) => r.shape === 'return-post'));
  assert.ok(routes.some((r) => r.shape === 'return-community'));
});

test('Recent is only planned when the community is in Recent', () => {
  for (const route of many(600, { ...EVERYTHING, inRecent: false, hasLead: false })) {
    assert.notEqual(entryOf(route.approach).params.via, 'recent');
  }
});

test('the Communities list and the feed are only planned for a joined community', () => {
  for (const route of many(600, { ...EVERYTHING, joined: false })) {
    for (const plan of [route.firstVisit, route.approach]) {
      const e = entryOf(plan);
      if (e) assert.ok(!['joined', 'feed'].includes(e.params.via), e.params.via);
    }
  }
});

test('without a lead there is nothing to come back from', () => {
  for (const route of many(600, { ...EVERYTHING, hasLead: false })) {
    assert.equal(route.shape, 'single');
    assert.deepEqual(route.firstVisit, []);
  }
});

test('looking in and coming back: in by anything but Recent, back through Recent', () => {
  for (let i = 0; i < 300; i++) {
    const route = composeCommentRoute({ ...EVERYTHING, rolls: { shape: 0.3, entry: Math.random() } });
    assert.equal(route.shape, 'return-community');
    assert.equal(route.firstVisit[0].type, 'open_home');
    const inBy = entryOf(route.firstVisit);
    assert.notEqual(inBy.params.via, 'recent');
    assert.equal(route.firstVisit.at(-1).type, 'scroll_feed');
    assert.ok(!types(route.firstVisit).includes('find_target'));

    assert.deepEqual(types(route.approach).slice(0, 4), ['enter_subreddit', 'scroll_feed', 'find_target', 'read_post']);
    assert.equal(route.approach[0].params.via, 'recent');
    assert.ok(!types(route.approach).includes('open_home'));
  }
});

test('sometimes the look-in does not scroll at all', () => {
  const bursts = new Set();
  for (let i = 0; i < 400; i++) {
    bursts.add(composeCommentRoute({ ...EVERYTHING, rolls: { shape: 0.3 } }).firstVisit.at(-1).params.bursts);
  }
  assert.ok(bursts.has(0));
  assert.ok(bursts.size > 2);
});

test('reading now and commenting later: the post is opened first and returned to', () => {
  for (let i = 0; i < 300; i++) {
    const route = composeCommentRoute({ ...EVERYTHING, rolls: { shape: 0.1 } });
    assert.equal(route.shape, 'return-post');
    const first = types(route.firstVisit);
    assert.deepEqual(first.slice(0, 1), ['open_home']);
    assert.ok(first.indexOf('find_target') > 0 && first.indexOf('read_post') > first.indexOf('find_target'));

    assert.deepEqual(types(route.approach).slice(0, 2), ['open_recent_post', 'read_post']);
    assert.equal(route.approach[0].params.redditPostId, TARGET.redditPostId);
    // The reading is split, not doubled.
    const firstRead = route.firstVisit.find((s) => s.type === 'read_post').params.seconds;
    const backRead = route.approach.find((s) => s.type === 'read_post').params.seconds;
    assert.ok(backRead <= 30 && firstRead >= 20);
    // One skim and one post vote at most, across both visits.
    const all = [...first, ...types(route.approach)];
    assert.ok(all.filter((t) => t === 'skim_comments').length <= 1);
    assert.ok(all.filter((t) => t === 'upvote_post').length <= 1);
  }
});

test('a first visit cannot post, and every job posts exactly once, last', () => {
  for (const route of many(1500, EVERYTHING)) {
    for (const step of route.firstVisit) {
      assert.ok(FIRST_VISIT_TYPES.has(step.type), step.type);
      assert.ok(FIRST_VISIT_APPROACH_TYPES.includes(step.type), step.type);
      assert.notEqual(step.type, 'post_comment');
    }
    const all = [...route.firstVisit, ...route.approach];
    assert.equal(all.filter((s) => s.type === 'post_comment').length, 1);
    assert.equal(route.approach.at(-1).type, 'post_comment');
    // A karma comment runs the same plans through COMMENT_TYPES.
    for (const step of all) {
      assert.ok(COMMENT_TYPES.has(step.type), step.type);
      assert.equal(typeof ACTIONS[step.type], 'function', step.type);
    }
  }
});

test('the first-visit list and the web list agree, and neither can post', () => {
  assert.deepEqual([...FIRST_VISIT_TYPES].sort(), [...FIRST_VISIT_APPROACH_TYPES].sort());
  assert.ok(!FIRST_VISIT_TYPES.has('post_comment'));
});

test('the shortcuts are not browsing steps: a warm-up and a lead cannot take them', () => {
  for (const t of ['enter_subreddit', 'open_recent_post']) {
    assert.ok(!WARMUP_TYPES.has(t));
    assert.ok(!LEAD_TYPES.has(t));
  }
});

test('every way in that is not search carries the search it falls back to', () => {
  for (const route of many(1500, EVERYTHING)) {
    for (const step of [...route.firstVisit, ...route.approach]) {
      if (step.type !== 'enter_subreddit' && step.type !== 'open_recent_post') continue;
      assert.ok(['typeahead', 'communities', 'posts'].includes(step.params.fallbackVia), String(step.params.fallbackVia));
      assert.match(approachStepCaveat(step), /search/);
    }
  }
});

test('the plan and the outcome say which way it went', () => {
  const step = { type: 'enter_subreddit', params: { subreddit: 'stake', sort: 'hot', via: 'recent', fallbackVia: 'typeahead' }, gapAfterSec: 1, jitterPct: 0 };
  assert.match(describeApproachStep(step), /r\/stake — from Recent in the sidebar/);
  assert.match(describeApproachOutcome({ type: 'enter_subreddit', ok: true, via: 'recent' }), /^From Recent/);
  assert.match(describeApproachOutcome({ type: 'enter_subreddit', ok: true, via: 'typeahead' }), /wasn’t there — from the search suggestions/);
  assert.match(describeApproachOutcome({ type: 'open_recent_post', ok: true, via: 'recent-posts' }), /^From Recent Posts/);
  assert.match(describeApproachOutcome({ type: 'open_recent_post', ok: true, via: 'direct' }), /Not in Recent Posts — went straight to it/);
});

test('what a plan may assume about a community comes from the account', () => {
  const account = { joinedOnReddit: ['Stake'], recentOnReddit: ['budget', 'AskReddit'] };
  assert.deepEqual(routeHints(account, 'stake'), { joined: true, inRecent: false });
  assert.deepEqual(routeHints(account, 'askreddit'), { joined: false, inRecent: true });
  assert.deepEqual(routeHints(null, 'stake'), { joined: false, inRecent: false });
  // Recent is not membership.
  assert.equal(routeHints({ recentOnReddit: ['stake'] }, 'stake').joined, false);
});

test('an unknown shape on an old job reads as a single visit', () => {
  assert.equal(normalizeRouteShape(undefined), 'single');
  assert.equal(normalizeRouteShape('return-post'), 'return-post');
  assert.ok(ENTRY_WEIGHTS.search > ENTRY_WEIGHTS.joined);
});
