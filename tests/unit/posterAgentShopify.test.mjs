// Posting to the Shopify Community — the decisions the agent makes without a
// browser.
//
// Policy, not just units:
//   - a job can only ever point the agent at a thread on community.shopify.com;
//   - "the composer holds what we meant" compares WORDS, so the two editors'
//     different paragraph handling cannot fail a correct reply, and a real
//     difference in wording cannot pass;
//   - a refusal says whether retrying the same text could ever work.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  boardUrl,
  classifyRefusal,
  composeShopifyPlan,
  isTopicUrl,
  permalinkFor,
  topicUrl,
  typedMatches,
  wordsOf,
} from '../../apps/poster-agent/shopify/plan.mjs';
import { PLATFORMS } from '../../apps/poster-agent/scheduler.mjs';

const job = { topicId: 681101, topicSlug: 'seo-geo-in-2026', categoryId: 288, categorySlug: 'seo', body: 'one two three four five six' };
const fixed = (min) => min;

test('the thread URL is built from the id, on this site only', () => {
  assert.equal(topicUrl(job), 'https://community.shopify.com/t/seo-geo-in-2026/681101');
  assert.equal(topicUrl({ topicId: 5, topicSlug: '../../evil.example/x' }), 'https://community.shopify.com/t/evilexamplex/5', 'a slug cannot steer the URL');
  assert.throws(() => topicUrl({ topicSlug: 'x' }), /no topic id/);
});

test('the board is optional; without it the approach starts at the thread', () => {
  assert.equal(boardUrl(job), 'https://community.shopify.com/c/seo/288');
  assert.equal(boardUrl({ topicId: 1 }), null);
  assert.deepEqual(composeShopifyPlan({ topicId: 1, body: 'x' }, fixed).map((s) => s.type), ['open_topic', 'read_topic', 'reply']);
  assert.deepEqual(composeShopifyPlan(job, fixed).map((s) => s.type), ['open_board', 'find_topic', 'open_topic', 'read_topic', 'reply']);
});

test('a page is the thread by topic id, whatever the slug or post number', () => {
  assert.ok(isTopicUrl('https://community.shopify.com/t/renamed-slug/681101', job));
  assert.ok(isTopicUrl('https://community.shopify.com/t/seo-geo-in-2026/681101/7', job));
  assert.ok(isTopicUrl('https://community.shopify.com/t/681101', job));
  assert.ok(!isTopicUrl('https://community.shopify.com/t/other/6811010', job), 'a longer id that starts the same is another thread');
  assert.ok(!isTopicUrl('https://evil.example/t/x/681101', job));
});

test('permalinks point at the post number', () => {
  assert.equal(permalinkFor(job, 12), 'https://community.shopify.com/t/seo-geo-in-2026/681101/12');
  assert.equal(permalinkFor(job, null), topicUrl(job));
});

test('the typed-text check compares words, not whitespace or markup', () => {
  const intended = 'The mistake wasn’t tone.\n\nIt was pitching the *wrong* person — twice.';
  const markdownEditor = "The mistake wasn't tone.\n\nIt was pitching the \\*wrong\\* person - twice.\n";
  const richEditor = "The mistake wasn't tone.\nIt was pitching the *wrong* person — twice.";
  assert.ok(typedMatches(intended, markdownEditor));
  assert.ok(typedMatches(intended, richEditor));
});

test('a dropped or changed word fails the check — that is what it is for', () => {
  assert.ok(!typedMatches('pitch the one writer who covers it', 'pitch the writer who covers it'));
  assert.ok(!typedMatches('never guaranteed', 'always guaranteed'));
  assert.ok(!typedMatches('', ''), 'an empty reply never matches');
  assert.equal(wordsOf('Hello,   WORLD!'), 'hello world');
});

test('refusals say whether retrying the same text could work', () => {
  assert.equal(classifyRefusal('Body is too similar to what you recently posted').retryable, false);
  assert.equal(classifyRefusal('New users can only put 2 links in a post.').retryable, false);
  assert.equal(classifyRefusal('You’ve performed this action too many times. Please wait 3 minutes.').retryable, true);
  assert.match(classifyRefusal('Your post was submitted and will be visible after it is approved by a moderator.').reason, /moderator review/);
  assert.match(classifyRefusal('').reason, /without saying why/);
});

test('the agent lists shopify as a platform it can post to', () => {
  assert.deepEqual([...PLATFORMS].sort(), ['reddit', 'shopify']);
});
