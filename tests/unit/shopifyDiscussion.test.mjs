// Turning a topic payload into a conversation, and a conversation into a prompt.
//
// The assertions worth having here are about what is REMOVED and what is
// GUARANTEED: a moderated placeholder must not reach a model as an opinion, a
// quoted reply must not count its own quote twice, and a summary must never
// drop the question it is a summary of.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decodeEntities, htmlToText } from '../../apps/web/src/modules/shopify/text.ts';
import {
  openingPost,
  parseDiscussion,
  renderDiscussion,
} from '../../apps/web/src/modules/shopify/discussion.ts';
import { EMPTY_DIGEST, parseDigest, wouldRepeat } from '../../apps/web/src/modules/shopify/digest.ts';

const post = (n, over = {}) => ({
  post_number: n,
  username: `user${n}`,
  created_at: '2026-09-01T10:00:00.000Z',
  cooked: `<p>Post number ${n} says something useful about schema markup.</p>`,
  like_count: 0,
  accepted_answer: false,
  reply_to_post_number: null,
  ...over,
});

const payload = (posts, over = {}) => ({
  id: 667253,
  slug: 'a-topic',
  title: 'How do we optimise for LLMs?',
  category_id: 288,
  tags: [],
  posts_count: posts.length,
  post_stream: { posts, stream: posts.map((p) => p.post_number) },
  ...over,
});

// ---------------------------------------------------------------------------

test('a moderated placeholder is dropped, not fed to the model as an opinion', () => {
  // Seen live in the SEO board: Discourse replaces a hidden post with real
  // prose that says nothing about the subject.
  const d = parseDiscussion(
    payload([
      post(1),
      post(2, { cooked: '<p>This post was flagged by the community and is temporarily hidden.</p>' }),
      post(3),
    ]),
  );
  assert.equal(d.posts.length, 2);
  assert.deepEqual(d.posts.map((p) => p.postNumber), [1, 3]);
});

test('an empty post is dropped too', () => {
  const d = parseDiscussion(payload([post(1), post(2, { cooked: '   ' })]));
  assert.equal(d.posts.length, 1);
});

test('dropping a moderated post does not make a complete read look truncated', () => {
  // `truncated` compares against the STREAM, not against how many survived
  // filtering — otherwise every thread with one hidden post reads as partial.
  const d = parseDiscussion(payload([post(1), post(2, { cooked: '<p>This post was flagged by the community.</p>' })]));
  assert.equal(d.truncated, false);
});

test('a partial payload is reported as partial', () => {
  const posts = [post(1), post(2)];
  const d = parseDiscussion(payload(posts, { posts_count: 24, post_stream: { posts, stream: Array.from({ length: 24 }, (_, i) => i + 1) } }));
  assert.equal(d.truncated, true);
  assert.equal(d.postsTotal, 24);
});

// ---------------------------------------------------------------------------

test('a quoted reply does not repeat the text it is quoting', () => {
  // Without this a model reads the same sentence three times and weights it
  // three times.
  const text = htmlToText(
    '<blockquote><p>Use schema markup everywhere.</p></blockquote><p>Agreed, and add llms.txt.</p>',
  );
  assert.ok(!text.includes('schema markup'), `quote leaked: ${text}`);
  assert.ok(text.includes('llms.txt'));
});

test('entities and list markup come back as readable text', () => {
  assert.equal(htmlToText('<p>A &amp; B</p>'), 'A & B');
  assert.ok(htmlToText('<ul><li>one</li><li>two</li></ul>').includes('• one'));
});

test('a listing excerpt is decoded, or the screen shows the entity', () => {
  // Caught in a browser: the excerpt reached the page as "these models
  // reco&hellip;" because React escapes what it renders. No API-level test
  // could see it — the string was "correct" all the way to the DOM.
  assert.equal(decodeEntities('these models reco&hellip;'), 'these models reco…');
  assert.equal(decodeEntities('Shopify&rsquo;s own &ldquo;answer&rdquo;'), 'Shopify’s own “answer”');
  assert.equal(decodeEntities('&#8230; and &#x2019;'), '… and ’');
});

test('decoding runs once, so &amp;lt; does not become a tag', () => {
  // Decoding &amp; first and then &lt; would turn this into "<".
  assert.equal(decodeEntities('&amp;lt;script&amp;gt;'), '&lt;script&gt;');
});

test('an entity we do not know is left alone rather than blanked', () => {
  assert.equal(decodeEntities('a &notarealentity; b'), 'a &notarealentity; b');
});

test('an accepted answer is found and recorded', () => {
  const d = parseDiscussion(payload([post(1), post(2, { accepted_answer: true })]));
  assert.equal(d.acceptedAnswerNumber, 2);
  assert.equal(d.posts[1].isAcceptedAnswer, true);
});

test('a payload with no id is refused rather than half-parsed', () => {
  assert.equal(parseDiscussion({ post_stream: { posts: [post(1)] } }), null);
  assert.equal(parseDiscussion(null), null);
});

// ---------------------------------------------------------------------------

test('a summary always keeps the question and the accepted answer', () => {
  // The budget is deliberately tiny here. Trimming to fit must never drop the
  // opening post — a summary without the question is not shorter, it is
  // useless.
  const posts = [
    post(1, { cooked: '<p>THE QUESTION being asked here</p>' }),
    ...Array.from({ length: 40 }, (_, i) => post(i + 2, { cooked: `<p>${'filler '.repeat(60)}</p>` })),
    post(99, { accepted_answer: true, cooked: '<p>THE ACCEPTED ANSWER</p>' }),
  ];
  const rendered = renderDiscussion(parseDiscussion(payload(posts)), 500);
  assert.ok(rendered.includes('THE QUESTION'), 'opening post was dropped');
  assert.ok(rendered.includes('THE ACCEPTED ANSWER'), 'accepted answer was dropped');
  assert.ok(/further repl/.test(rendered), 'omissions were not disclosed');
});

test('when it must choose, it keeps the most-liked replies rather than the fastest', () => {
  const posts = [
    post(1),
    post(2, { like_count: 0, cooked: '<p>FIRST REPLY nobody liked</p>' }),
    post(3, { like_count: 40, cooked: '<p>BEST REPLY the room liked</p>' }),
  ];
  const rendered = renderDiscussion(parseDiscussion(payload(posts)), 260);
  assert.ok(rendered.includes('BEST REPLY'), 'the liked reply was dropped for a chronological one');
});

test('posts are rendered in thread order even when chosen by likes', () => {
  const posts = [post(1), post(2, { like_count: 1 }), post(3, { like_count: 99 })];
  const rendered = renderDiscussion(parseDiscussion(payload(posts)));
  assert.ok(rendered.indexOf('#2') < rendered.indexOf('#3'), 'order was scrambled by the ranking');
});

// ---------------------------------------------------------------------------

test('the opening post is found for the analysis, which reads nothing else', () => {
  const d = parseDiscussion(payload([post(1, { cooked: '<p>THE QUESTION</p>' }), post(2)]));
  assert.equal(openingPost(d).text, 'THE QUESTION');
  // A thread whose first post was moderated away has no question to analyse.
  assert.equal(openingPost(parseDiscussion(payload([post(2)]))), null);
});

// ---------------------------------------------------------------------------
// The digest — what the replies already say, reported by the DRAFT call.

test('a missing or broken digest does not throw the reply away with it', () => {
  // Lenient on purpose: the product of the draft call is the reply.
  assert.deepEqual(parseDigest(undefined).offered, []);
  assert.equal(parseDigest('nonsense').whatIsMissing, '');
});

test('an engagement value we do not recognise falls back rather than reaching the screen', () => {
  assert.equal(parseDigest({ engagement: 'vibes' }).engagement, 'discussion');
});

test('an offered solution with no approach is dropped', () => {
  const d = parseDigest({
    offered: [{ approach: '', byUsername: 'a' }, { approach: 'add schema', byUsername: 'b', postNumber: 4, endorsed: true }],
  });
  assert.equal(d.offered.length, 1);
  assert.equal(d.offered[0].endorsed, true);
  assert.equal(d.offered[0].postNumber, 4);
});

test('a well-answered thread with no gap is repetition, and it is free to say so', () => {
  assert.ok(wouldRepeat({ ...EMPTY_DIGEST, engagement: 'answered-well', whatIsMissing: '' }));
  assert.ok(!wouldRepeat({ ...EMPTY_DIGEST, engagement: 'answered-well', whatIsMissing: 'nobody measured it' }));
  assert.ok(!wouldRepeat({ ...EMPTY_DIGEST, engagement: 'unanswered', whatIsMissing: '' }));
});
