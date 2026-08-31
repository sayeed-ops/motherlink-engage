// Finding candidate pages on a client's domains — and, mostly, not leaving them.
//
// Two things here could go badly wrong and both are tested hard:
//
//   THE CRAWL BOUNDARY. A link crawl follows what it finds, and a gambling
//   operator's footer points at Twitter, a payment processor, a licensing body
//   and a dozen affiliates. If hostAllowed is wrong, "discover the client's
//   pages" quietly becomes "crawl the open web".
//
//   THE LOCALE FOLD. A help centre exists in thirty languages, so a sitemap
//   returns thirty copies of every article. Without folding, the review queue is
//   thirty times longer and each duplicate costs a separate ingest.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCandidates,
  dedupeKey,
  extractLinks,
  hostAllowed,
  isDisallowed,
  normaliseDomain,
  parseRobots,
  parseSitemap,
  preferredLocale,
  triageUrl,
} from '../../apps/web/src/modules/knowledge/discovery.ts';
import { parseClassifications } from '../../apps/web/src/modules/knowledge/classify.ts';

// ── domains ────────────────────────────────────────────────────────────────

test('a domain is normalised however it was typed', () => {
  for (const input of ['Northwind.example', 'https://northwind.example/', 'https://www.northwind.example/help', 'northwind.example']) {
    assert.equal(normaliseDomain(input), 'northwind.example', input);
  }
});

test('rubbish normalises to empty rather than to something plausible', () => {
  assert.equal(normaliseDomain(''), '');
  assert.equal(normaliseDomain('   '), '');
});

// ── the crawl boundary ─────────────────────────────────────────────────────

test('the approved domain and its subdomains are in', () => {
  assert.equal(hostAllowed('https://northwind.example/help', ['northwind.example']), true);
  assert.equal(hostAllowed('https://help.northwind.example/articles/1', ['northwind.example']), true);
  assert.equal(hostAllowed('https://www.northwind.example/x', ['northwind.example']), true);
});

test('a domain that merely ENDS with an approved one is out', () => {
  // The attack this dot prevents: notnorthwind.example passing because northwind.example was
  // approved. Cheap to get wrong with endsWith and expensive to notice.
  assert.equal(hostAllowed('https://notnorthwind.example/x', ['northwind.example']), false);
  assert.equal(hostAllowed('https://northwind.example.evil.test/x', ['northwind.example']), false);
});

test('everything a footer points at is out', () => {
  for (const url of [
    'https://twitter.com/northwind',
    'https://curacao-egaming.com/licence',
    'https://affiliate-network.test/join',
  ]) {
    assert.equal(hostAllowed(url, ['northwind.example']), false, url);
  }
});

test('a malformed URL is not allowed by accident', () => {
  assert.equal(hostAllowed('not a url', ['northwind.example']), false);
});

// ── robots.txt ─────────────────────────────────────────────────────────────

const ROBOTS = `# hello
User-agent: Googlebot
Disallow: /nothing-for-google/

User-agent: *
Disallow: /account/
Disallow: /checkout
Allow: /help/

Sitemap: https://northwind.example/sitemap.xml
Sitemap: https://help.northwind.example/sitemap.xml`;

test('sitemaps are read wherever they appear', () => {
  assert.deepEqual(parseRobots(ROBOTS).sitemaps, [
    'https://northwind.example/sitemap.xml',
    'https://help.northwind.example/sitemap.xml',
  ]);
});

test('only the rules addressed to everyone are obeyed', () => {
  // We do not publish a named agent, so a group addressed to Googlebot is not
  // addressed to us — and treating it as ours would block pages we may read.
  const rules = parseRobots(ROBOTS).disallow;
  assert.deepEqual(rules, ['/account/', '/checkout']);
  assert.ok(!rules.includes('/nothing-for-google/'));
});

test('disallow matches by prefix, and a bare slash blocks everything', () => {
  assert.equal(isDisallowed('/account/settings', ['/account/']), true);
  assert.equal(isDisallowed('/checkout', ['/checkout']), true);
  assert.equal(isDisallowed('/help/cashout', ['/account/']), false);
  assert.equal(isDisallowed('/anything', ['/']), true);
});

test('a wildcard rule blocks its literal prefix', () => {
  assert.equal(isDisallowed('/tmp-123/x', ['/tmp-*']), true);
  assert.equal(isDisallowed('/help/x', ['/tmp-*']), false);
});

// ── sitemaps ───────────────────────────────────────────────────────────────

test('a urlset yields its URLs', () => {
  const xml = `<urlset><url><loc>https://northwind.example/help/a</loc></url><url><loc>https://northwind.example/help/b</loc></url></urlset>`;
  const { urls, isIndex } = parseSitemap(xml);
  assert.equal(isIndex, false);
  assert.deepEqual(urls, ['https://northwind.example/help/a', 'https://northwind.example/help/b']);
});

test('a sitemap index is reported as one, so the caller recurses', () => {
  const xml = `<sitemapindex><sitemap><loc>https://northwind.example/sitemap-1.xml</loc></sitemap></sitemapindex>`;
  const { urls, isIndex } = parseSitemap(xml);
  assert.equal(isIndex, true);
  assert.deepEqual(urls, ['https://northwind.example/sitemap-1.xml']);
});

test('CDATA and entities survive', () => {
  const xml = `<urlset><url><loc><![CDATA[https://northwind.example/a?x=1&amp;y=2]]></loc></url></urlset>`;
  assert.deepEqual(parseSitemap(xml).urls, ['https://northwind.example/a?x=1&y=2']);
});

// ── links ──────────────────────────────────────────────────────────────────

test('anchor text is captured, because it is the best free signal there is', () => {
  const html = `<a href="/help/cashout">Why did my cashout disappear?</a>`;
  const [link] = extractLinks(html, 'https://northwind.example/help');
  assert.equal(link.url, 'https://northwind.example/help/cashout');
  assert.equal(link.anchor, 'Why did my cashout disappear?');
});

test('relative, absolute and quoted-any-way hrefs all resolve', () => {
  const html = `<a href='/a'>A</a><a href="https://northwind.example/b">B</a><a href=/c>C</a>`;
  assert.deepEqual(
    extractLinks(html, 'https://northwind.example/x/y').map((l) => l.url),
    ['https://northwind.example/a', 'https://northwind.example/b', 'https://northwind.example/c'],
  );
});

test('non-navigational hrefs are skipped', () => {
  const html = `<a href="#top">Top</a><a href="mailto:a@b.c">Mail</a><a href="javascript:void(0)">JS</a>`;
  assert.equal(extractLinks(html, 'https://northwind.example/').length, 0);
});

test('markup inside an anchor is flattened, not kept', () => {
  const html = `<a href="/a"><span class="i"></span> Cashout <b>help</b></a>`;
  assert.equal(extractLinks(html, 'https://northwind.example/')[0].anchor, 'Cashout help');
});

// ── triage ─────────────────────────────────────────────────────────────────

test('help and guide paths are kept', () => {
  assert.equal(triageUrl('https://northwind.example/help/cashout-unavailable').keep, true);
  assert.equal(triageUrl('https://northwind.example/blog/what-is-margin').keep, true);
  assert.equal(triageUrl('https://northwind.example/policies/terms').keep, true);
});

test('the queue is not filled with logins, baskets and tag archives', () => {
  // An operator who has to skip forty junk rows to find one good one stops
  // opening the queue, and then discovery has cost more than it saved.
  for (const url of [
    'https://northwind.example/login',
    'https://northwind.example/account/settings',
    'https://northwind.example/cart',
    'https://northwind.example/blog/tag/nfl',
    'https://northwind.example/blog/page/7',
    'https://northwind.example/feed',
    'https://northwind.example/assets/app.js',
    'https://northwind.example/sitemap.xml',
  ]) {
    assert.equal(triageUrl(url).keep, false, url);
  }
});

test('the homepage is refused as too general to cite', () => {
  assert.equal(triageUrl('https://northwind.example/').keep, false);
});

test('a path with nothing promising in it is dropped rather than guessed at', () => {
  assert.equal(triageUrl('https://northwind.example/xyzzy/1234').keep, false);
});

test('a deeper path outranks its own index, but not a better section', () => {
  const deep = triageUrl('https://northwind.example/help/betting/cashout/unavailable').score;
  const shallow = triageUrl('https://northwind.example/help').score;
  assert.ok(deep > shallow, 'specific beats general');
  assert.ok(triageUrl('https://northwind.example/help/x').score > triageUrl('https://northwind.example/promotions/x').score);
});

// ── the locale fold ────────────────────────────────────────────────────────

test('the same article in thirty languages is one candidate', () => {
  const key = dedupeKey('https://northwind.example/en/help/cashout');
  for (const locale of ['de', 'fr', 'pt', 'ja', 'tr']) {
    assert.equal(dedupeKey(`https://northwind.example/${locale}/help/cashout`), key, locale);
  }
  assert.equal(dedupeKey('https://northwind.example/help/cashout'), key, 'unprefixed is the same page too');
});

test('tracking parameters do not make a new page', () => {
  assert.equal(
    dedupeKey('https://northwind.example/help/cashout?utm_source=x&gclid=y'),
    dedupeKey('https://northwind.example/help/cashout'),
  );
});

test('a meaningful query parameter DOES make a different page', () => {
  assert.notEqual(
    dedupeKey('https://northwind.example/help/article?id=1'),
    dedupeKey('https://northwind.example/help/article?id=2'),
  );
});

test('www and case do not make a new page', () => {
  assert.equal(dedupeKey('https://WWW.Northwind.example/help/a'), dedupeKey('https://northwind.example/help/a'));
});

test('the English copy is the one preferred for display', () => {
  assert.equal(preferredLocale('https://northwind.example/en/help/a'), true);
  assert.equal(preferredLocale('https://northwind.example/help/a'), true);
  assert.equal(preferredLocale('https://northwind.example/de/help/a'), false);
});

// ── building the queue ─────────────────────────────────────────────────────

const found = (over = {}) => ({ url: 'https://northwind.example/help/cashout', source: 'sitemap', ...over });

test('off-domain, disallowed and junk URLs never become candidates', () => {
  const out = buildCandidates(
    [
      found(),
      found({ url: 'https://twitter.com/northwind' }),
      found({ url: 'https://northwind.example/account/settings' }),
      found({ url: 'https://northwind.example/help/private' }),
    ],
    { domains: ['northwind.example'], known: new Set(), disallow: ['/help/private'] },
  );
  assert.deepEqual(out.map((c) => c.url), ['https://northwind.example/help/cashout']);
});

test('a page seen in both a sitemap and a link keeps the anchor', () => {
  const out = buildCandidates(
    [found(), found({ source: 'link', anchor: 'Why did my cashout disappear?' })],
    { domains: ['northwind.example'], known: new Set() },
  );
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].anchors, ['Why did my cashout disappear?']);
  assert.equal(out[0].source, 'link', 'an anchor sighting outranks a bare sitemap listing');
});

test('locale duplicates collapse and the English URL is the one kept', () => {
  const out = buildCandidates(
    [
      found({ url: 'https://northwind.example/de/help/cashout' }),
      found({ url: 'https://northwind.example/en/help/cashout' }),
      found({ url: 'https://northwind.example/ja/help/cashout' }),
    ],
    { domains: ['northwind.example'], known: new Set() },
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].url, 'https://northwind.example/en/help/cashout');
});

test('pages already in the library or already decided on are never re-offered', () => {
  // Showing an operator a page they ignored last Monday, every Monday, is how a
  // review queue stops being opened.
  const known = new Set([dedupeKey('https://northwind.example/help/cashout')]);
  const out = buildCandidates([found(), found({ url: 'https://northwind.example/de/help/cashout' })], {
    domains: ['northwind.example'],
    known,
  });
  assert.equal(out.length, 0, 'and a locale variant of a known page is still known');
});

test('the limit caps the queue at something a person can work through', () => {
  const many = Array.from({ length: 40 }, (_, i) => found({ url: `https://northwind.example/help/a${i}` }));
  assert.equal(buildCandidates(many, { domains: ['northwind.example'], known: new Set(), limit: 10 }).length, 10);
});

// ── classification ─────────────────────────────────────────────────────────

test('classifications are keyed by URL, never by position', () => {
  // A model asked for three rows sometimes returns two. Reading positionally
  // would then attach every later guess to the wrong page — silently, and it
  // would look completely fine on screen.
  const parsed = parseClassifications({
    results: [
      { url: 'https://northwind.example/c', usefulFor: 'third', kind: 'help', confidence: 90, worthReading: true },
      { url: 'https://northwind.example/a', usefulFor: 'first', kind: 'guide', confidence: 50, worthReading: true },
    ],
  });
  assert.equal(parsed.get('https://northwind.example/a').usefulFor, 'first');
  assert.equal(parsed.get('https://northwind.example/c').usefulFor, 'third');
  assert.equal(parsed.get('https://northwind.example/b'), undefined, 'a page it skipped simply has no guess');
});

test('worthReading defaults to false when the model omits it', () => {
  // The default has to fall on the side that costs nothing. An unread good page
  // is a missed opportunity; a queue full of junk is a feature nobody opens
  // twice.
  const parsed = parseClassifications({ results: [{ url: 'https://northwind.example/a', usefulFor: 'x' }] });
  assert.equal(parsed.get('https://northwind.example/a').worthReading, false);
});

test('a confidence outside 0-100 is clamped rather than believed', () => {
  const parsed = parseClassifications({
    results: [
      { url: 'https://northwind.example/a', confidence: 480, worthReading: true },
      { url: 'https://northwind.example/b', confidence: -20, worthReading: true },
      { url: 'https://northwind.example/c', confidence: 'lots', worthReading: true },
    ],
  });
  assert.equal(parsed.get('https://northwind.example/a').confidence, 100);
  assert.equal(parsed.get('https://northwind.example/b').confidence, 0);
  assert.equal(parsed.get('https://northwind.example/c').confidence, 0);
});

test('an unusable response yields an empty map rather than throwing', () => {
  assert.equal(parseClassifications(null).size, 0);
  assert.equal(parseClassifications({ results: 'nope' }).size, 0);
  assert.equal(parseClassifications({ results: [{ noUrl: true }] }).size, 0);
});
