// The community finder: persona and suggestion parsing, and the check the
// agent runs on a community's page before it joins.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSuggestPrompt,
  parsePersona,
  parseSuggestions,
  blockedCommunities,
  notForComments,
  readCommunityCheck,
} from '../../apps/web/src/modules/reddit/communityFinder.ts';
import {
  blocksJoin,
  COMMUNITY_LIMITS,
  isAppAccount,
  judgeCommunity,
  parseCount,
  weeklyVisitorsFrom,
} from '../../apps/poster-agent/reddit/community-check.mjs';

const persona = {
  summary: 'A UX designer in Boston who walks her dog every morning.',
  ageRange: '30-35',
  occupation: 'UX designer',
  location: 'Boston',
  interests: ['dogs', 'hiking', 'baking'],
  avoid: ['gambling'],
};

test('a persona needs a summary and interests; extra fields are dropped', () => {
  assert.equal(parsePersona({ summary: '', interests: ['x'] }), null);
  assert.equal(parsePersona({ summary: 'x', interests: [] }), null);
  const p = parsePersona({ ...persona, secret: 'no' });
  assert.deepEqual(Object.keys(p).sort(), ['ageRange', 'avoid', 'interests', 'location', 'occupation', 'summary']);
});

test('the suggestion prompt asks for a mix, not only the job', () => {
  const prompt = buildSuggestPrompt({ persona, count: 15, exclude: ['seo'], avoidShared: ['cats'] });
  assert.match(prompt, /About 5 close/);
  assert.match(prompt, /do not need to relate to the work/);
  assert.match(prompt, /Do not suggest any of these: seo/);
  assert.match(prompt, /prefer different ones: cats/);
  assert.match(prompt, /leave it out rather than invent one/);
  assert.match(prompt, /1,000 to 50,000 weekly visitors/);
});

test('suggestions are cleaned: no excluded, no repeats, at most 3 keywords', () => {
  const out = parseSuggestions(
    {
      communities: [
        { name: 'r/Hiking', kind: 'interest', why: 'walks', keywords: ['best day hikes near me', 'beginner hiking tips', 'hiking', 'extra one'] },
        { name: 'hiking', kind: 'interest', keywords: [] },
        { name: 'seo', kind: 'close', keywords: [] },
        { name: 'bad name!', kind: 'general' },
        { name: 'Sourdough', kind: 'weird', keywords: ['sourdough'] },
      ],
    },
    ['seo'],
  );
  assert.deepEqual(out.map((s) => s.name), ['hiking', 'sourdough']);
  assert.equal(out[0].keywords.length, 3);
  assert.equal(out[1].kind, 'interest');
});

test('a hard rejection blocks everything; a soft one only comments', () => {
  const checks = {
    Hiking: { status: 'rejected', hard: false, reason: '900,000 weekly visitors' },
    privatestuff: { status: 'rejected', hard: true, reason: 'private community' },
    baking: { status: 'passed' },
    dogs: { status: 'pending' },
  };
  assert.deepEqual([...blockedCommunities(checks)], ['privatestuff']);
  assert.deepEqual([...notForComments(checks)].sort(), ['hiking', 'privatestuff']);
  assert.equal(readCommunityCheck({ status: 'odd' }).status, 'pending');
  assert.equal(readCommunityCheck({ status: 'pending', hard: true }).hard, false);
});

test('counts read as Reddit writes them', () => {
  assert.equal(parseCount('12.3K'), 12300);
  assert.equal(parseCount('1,234'), 1234);
  assert.equal(parseCount('1.2M'), 1200000);
  assert.equal(parseCount('lots'), null);
});

test('weekly visitors are found with the label on either side', () => {
  assert.equal(weeklyVisitorsFrom('About\n12K\nweekly visitors\n340 weekly contributions'), 12000);
  assert.equal(weeklyVisitorsFrom('Weekly visitors: 8,500'), 8500);
  assert.equal(weeklyVisitorsFrom('nothing here'), null);
});

test('app and bot accounts count as add-ons', () => {
  for (const n of ['AutoModerator', 'u/bot-bouncer', 'modrelayhq', 'SomeHelperBot']) assert.equal(isAppAccount(n), true, n);
  assert.equal(isAppAccount('jane_doe'), false);
});

test('the verdict follows the limits', () => {
  const ok = { weeklyVisitors: 12000, moderators: ['a', 'b'], apps: [] };
  assert.equal(judgeCommunity(ok).status, 'passed');
  assert.equal(judgeCommunity({ ...ok, weeklyVisitors: 60000 }).status, 'rejected');
  assert.equal(judgeCommunity({ ...ok, weeklyVisitors: 500 }).status, 'rejected');
  assert.equal(judgeCommunity({ ...ok, moderators: ['a', 'b', 'c'] }).status, 'rejected');
  assert.match(judgeCommunity({ ...ok, moderators: ['a', 'automoderator'] }).reason, /add-ons installed: automoderator/);
  assert.match(judgeCommunity({ ...ok, apps: ['Ban Purge'] }).reason, /Ban Purge/);
  assert.equal(judgeCommunity({ ...ok, private: true }).reason, 'private community');
  assert.equal(judgeCommunity({ ...ok, private: true }).hard, true);
  assert.equal(judgeCommunity({ ...ok, weeklyVisitors: 60000 }).hard, false);
  assert.equal(judgeCommunity({ ...ok, weeklyVisitors: null }).status, 'unreadable');
  assert.equal(judgeCommunity({ ...ok, moderators: null }).status, 'unreadable');
  assert.equal(COMMUNITY_LIMITS.maxModerators, 2);
});

test('a big community is still joined quietly; a blocked one never is', async () => {
  const { joinTargetsOf } = await import('../../apps/web/src/server/warmupSession.ts');
  const account = {
    warmupCommunities: [
      { name: 'pourover', roles: ['browse', 'follow'] },
      { name: 'coffee', roles: ['browse', 'follow'] },
      { name: 'secretclub', roles: ['browse', 'follow'] },
    ],
    communityChecks: {
      coffee: { status: 'rejected', hard: false, reason: '900,000 weekly visitors' },
      secretclub: { status: 'rejected', hard: true, reason: 'private community' },
    },
    joinedConfirmed: [],
  };
  assert.deepEqual(joinTargetsOf(account).sort(), ['coffee', 'pourover']);
});

test('the commenting limits block a join only where the account will comment', () => {
  const big = judgeCommunity({ weeklyVisitors: 900000, moderators: ['a'], apps: [] });
  assert.equal(blocksJoin(big, false), false);
  assert.equal(blocksJoin(big, true), true);
  const unreadable = judgeCommunity({ weeklyVisitors: null, moderators: null, apps: [] });
  assert.equal(blocksJoin(unreadable, false), false);
  assert.equal(blocksJoin(unreadable, true), true);
  assert.equal(blocksJoin(judgeCommunity({ weeklyVisitors: 5000, moderators: [], apps: [], adult: true }), false), true);
});
