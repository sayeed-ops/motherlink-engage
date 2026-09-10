// Reading a Shopify Community board listing, and the free screen over it.
//
// The load-bearing assertion in this file is the `reply_count` one. Discourse
// reports a number called reply_count that is NOT the number of replies, and
// believing it would make the busiest threads on the board look abandoned. That
// was caught against the live site rather than against a fixture, which is the
// same way every serious Covers defect was found — a fixture proves the parser
// agrees with itself, and nothing more.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_LIMITS,
  isWorthReading,
  parseTopic,
  parseTopicList,
  screenTopic,
} from '../../apps/web/src/modules/shopify/topics.ts';
import {
  categoryListUrl,
  normaliseSort,
  parseCategoryList,
  topicWebUrl,
} from '../../apps/web/src/modules/shopify/categories.ts';

const DAY = 86_400_000;
const NOW = Date.parse('2026-09-10T00:00:00.000Z');

/** Shaped exactly like a row from /c/seo/288/l/latest.json. */
const row = (over = {}) => ({
  id: 667253,
  slug: 'getting-traffic-from-chatgpt',
  title: 'Getting traffic from ChatGPT & AI agents, where do I even start?',
  excerpt: 'So I keep hearing about people getting traffic…',
  category_id: 288,
  tags: [],
  reply_count: 0,
  posts_count: 23,
  views: 572,
  like_count: 14,
  created_at: '2026-09-01T10:00:00.000Z',
  last_posted_at: '2026-09-08T10:00:00.000Z',
  has_accepted_answer: false,
  closed: false,
  archived: false,
  pinned: false,
  visible: true,
  ...over,
});

// ---------------------------------------------------------------------------

test('reply_count is not the number of replies — posts_count is', () => {
  // The real payload for this topic: 23 posts, reply_count 0. Believing
  // reply_count would call a 23-post discussion unanswered.
  const t = parseTopic(row());
  assert.equal(t.replyCount, 0, 'the raw field is carried as-is');
  assert.equal(t.postsCount, 23);
  assert.equal(t.replies, 22, 'replies = posts minus the opening post');
});

test('reply_count can exceed posts_count, so it cannot be a size', () => {
  // "About the SEO category" really reports 8 against 7. Any code treating
  // reply_count as a count of posts would produce a negative remainder.
  const t = parseTopic(row({ reply_count: 8, posts_count: 7 }));
  assert.equal(t.replies, 6);
  assert.ok(t.replies >= 0);
});

test('a malformed posts_count cannot produce negative replies', () => {
  assert.equal(parseTopic(row({ posts_count: 0 })).replies, 0);
  assert.equal(parseTopic(row({ posts_count: 'nonsense' })).replies, 0);
});

test('a busy thread is never screened out as ignored', () => {
  // The bug this pins: screening on replyCount would fire `ignored` on a topic
  // with 22 replies, because reply_count reads 0.
  const t = parseTopic(row({ views: 5 }));
  const { reasons } = screenTopic(t, NOW);
  assert.ok(!reasons.includes('ignored'), `busy thread wrongly ignored: ${reasons}`);
});

test('genuinely ignored means no replies AND nobody reading', () => {
  const t = parseTopic(row({ posts_count: 1, views: 4 }));
  assert.ok(screenTopic(t, NOW).reasons.includes('ignored'));
});

test('a question nobody answered but everybody read survives the screen', () => {
  // The most valuable shape on the board, and the one a naive "no replies =
  // dead" rule would delete.
  const t = parseTopic(row({ posts_count: 1, views: 2400 }));
  assert.ok(isWorthReading(screenTopic(t, NOW)));
});

// ---------------------------------------------------------------------------

test('an accepted answer is a skip, and it is configurable', () => {
  const t = parseTopic(row({ has_accepted_answer: true }));
  assert.ok(screenTopic(t, NOW).reasons.includes('answered'));
  assert.ok(!screenTopic(t, NOW, { ...DEFAULT_LIMITS, skipAnswered: false }).reasons.includes('answered'));
});

test('closed, archived, pinned and hidden are each stated', () => {
  assert.ok(screenTopic(parseTopic(row({ closed: true })), NOW).reasons.includes('closed'));
  assert.ok(screenTopic(parseTopic(row({ archived: true })), NOW).reasons.includes('closed'));
  assert.ok(screenTopic(parseTopic(row({ pinned: true })), NOW).reasons.includes('pinned'));
  assert.ok(screenTopic(parseTopic(row({ visible: false })), NOW).reasons.includes('hidden'));
});

test('absent `visible` reads as visible, not as hidden', () => {
  const r = row();
  delete r.visible;
  assert.ok(!screenTopic(parseTopic(r), NOW).reasons.includes('hidden'));
});

test('quiet is measured from the last post, against the configured window', () => {
  const old = parseTopic(row({ last_posted_at: new Date(NOW - 90 * DAY).toISOString() }));
  assert.ok(screenTopic(old, NOW).reasons.includes('quiet'));
  const fresh = parseTopic(row({ last_posted_at: new Date(NOW - 10 * DAY).toISOString() }));
  assert.ok(!screenTopic(fresh, NOW).reasons.includes('quiet'));
});

test('bumped_at stands in when last_posted_at is missing', () => {
  const r = row({ last_posted_at: null, bumped_at: new Date(NOW - 2 * DAY).toISOString() });
  assert.equal(parseTopic(r).lastPostedAtMs, NOW - 2 * DAY);
});

test('every topic gets a verdict, including the rejected ones', () => {
  // Screening that filters rather than records is why "the queue is empty" was
  // unanswerable on Covers for a week.
  const t = parseTopic(row({ closed: true, pinned: true }));
  const { reasons } = screenTopic(t, NOW);
  assert.deepEqual(reasons.sort(), ['closed', 'pinned']);
});

// ---------------------------------------------------------------------------

test('a row with no id or no slug is dropped, not defaulted', () => {
  assert.equal(parseTopic(row({ id: null })), null);
  assert.equal(parseTopic(row({ slug: '' })), null);
  const { topics } = parseTopicList({ topic_list: { topics: [row(), row({ id: 0 })] } });
  assert.equal(topics.length, 1);
});

test('a listing with no topic_list is empty rather than a crash', () => {
  assert.deepEqual(parseTopicList(null), { topics: [], moreUrl: null });
  assert.deepEqual(parseTopicList({}), { topics: [], moreUrl: null });
});

test('more_topics_url is carried when present', () => {
  const { moreUrl } = parseTopicList({
    topic_list: { topics: [row()], more_topics_url: '/c/seo/288/l/latest?page=1' },
  });
  assert.equal(moreUrl, '/c/seo/288/l/latest?page=1');
});

// ---------------------------------------------------------------------------

test('a category URL carries both slug and id, because Discourse needs both', () => {
  assert.equal(
    categoryListUrl({ id: 288, slug: 'seo' }, 'latest'),
    'https://community.shopify.com/c/seo/288/l/latest.json',
  );
  assert.equal(
    categoryListUrl({ id: 288, slug: 'seo' }, 'hot', 2),
    'https://community.shopify.com/c/seo/288/l/hot.json?page=2',
  );
});

test('an unusable sort falls back to latest rather than reaching a URL', () => {
  assert.equal(normaliseSort('votes'), 'votes');
  assert.equal(normaliseSort('../../admin'), 'latest');
  assert.equal(normaliseSort(undefined), 'latest');
});

test('the topic link a person clicks is the page, not the JSON', () => {
  assert.equal(topicWebUrl(667253, 'getting-traffic'), 'https://community.shopify.com/t/getting-traffic/667253');
});

test('the category catalogue drops rows it cannot address', () => {
  const cats = parseCategoryList({
    category_list: {
      categories: [
        { id: 288, slug: 'seo', name: 'SEO', topic_count: 201 },
        { id: 288, slug: 'seo-dupe', name: 'Duplicate id' },
        { id: null, slug: 'broken', name: 'No id' },
        { id: 291, slug: '', name: 'No slug' },
      ],
    },
  });
  assert.equal(cats.length, 1);
  assert.equal(cats[0].name, 'SEO');
  assert.equal(cats[0].parentId, null, 'no hierarchy is invented');
});
