// Which communities an account has joined.
//
// The bug this replaces: the agent read every /r/ link in Reddit's left sidebar
// as a membership, including the RECENT section of communities the account had
// only visited. Those were recorded as joined, could never be corrected, and
// follow sessions skipped them for good — while comment karma went on writing
// comments in communities the account had never joined.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hasJoinedSnapshot, joinedCommunities, joinedSources } from '../../apps/web/src/modules/reddit/joined.ts';
import { commentPairs } from '../../apps/web/src/modules/reddit/commentKarma/pairs.ts';
import { normalizeCommentSettings, scanReadiness } from '../../apps/web/src/modules/forum/reply/settings.ts';

test('joined is the three sources together, and nothing else', () => {
  const account = {
    joinedOnReddit: ['gambling', 'OnlineGambling'],
    joinedConfirmed: ['learnmath'],
    joinedManual: ['camping', 'gambling'],
    // The old, polluted list. Nothing reads it any more.
    followedSubreddits: ['stake', 'parenting'],
  };
  assert.deepEqual(joinedCommunities(account), ['gambling', 'onlinegambling', 'learnmath', 'camping']);
  assert.ok(!joinedCommunities(account).includes('stake'));
  assert.deepEqual(joinedSources(account).gambling, ['reddit', 'manual']);
  assert.deepEqual(joinedSources(account).learnmath, ['confirmed']);
});

test('an account nothing is known about has joined nothing', () => {
  assert.deepEqual(joinedCommunities(undefined), []);
  assert.deepEqual(joinedCommunities({ followedSubreddits: ['stake'] }), []);
  assert.equal(hasJoinedSnapshot({}), false);
  assert.equal(hasJoinedSnapshot({ joinedOnRedditAt: { toMillis: () => 1 } }), true);
});

const COMMUNITIES = [
  { name: 'stake', roles: ['browse', 'follow', 'comment'], keywords: ['bonus'] },
  { name: 'gambling', roles: ['browse', 'follow', 'comment'], keywords: [] },
  { name: 'learnmath', roles: ['browse'], keywords: [] },
];

test('comment karma only looks in communities the account has joined', () => {
  assert.deepEqual(commentPairs(COMMUNITIES, ['odds'], ['gambling']).map((p) => p.subreddit), ['gambling']);
  // Joined but not tagged Comment is still not a place to comment.
  assert.deepEqual(commentPairs(COMMUNITIES, ['odds'], ['learnmath']), []);
  // Without a joined list the old behaviour stands, for callers that have none.
  assert.deepEqual(commentPairs(COMMUNITIES, ['odds']).map((p) => p.subreddit), ['stake', 'gambling']);
});

test('nowhere to look because nothing is joined says exactly that', () => {
  const on = normalizeCommentSettings({ enabled: true });
  assert.match(scanReadiness(on, [], 2).reason, /2 communities are tagged Comment, but this account has not joined any of them/);
  assert.match(scanReadiness(on, [], 1).reason, /1 community is tagged Comment, but this account has not joined it/);
  // Nothing tagged at all is still the old message.
  assert.match(scanReadiness(on, []).reason, /No communities are tagged Comment/);
});
