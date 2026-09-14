// Queueing a Shopify Community reply — the rules the screen and the route share,
// and the account-platform helpers they lean on.
//
// Policy, not just units:
//   - an agent that cannot be PROVEN to know Shopify jobs is refused, including
//     a newer agent's stale `platforms` list left in a heartbeat an older agent
//     is now writing to;
//   - a forbidden phrase stops a post even if it was forbidden after the draft
//     was written;
//   - a Reddit account can never be used for a Shopify post, and the other way.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { accountRefusal, agentRefusal, draftRefusal } from '../../apps/web/src/modules/shopify/posting.ts';
import { accountPlatform, cleanUsername, handleOf } from '../../apps/web/src/modules/accounts/platform.ts';
import { parseForumUser, trustLevelNote, ForumUserNotFound } from '../../apps/web/src/modules/shopify/forumUser.ts';

const NOW = Date.UTC(2026, 8, 13, 12, 0, 0);
const approved = { status: 'approved', text: 'A reply that is comfortably long enough to post.', forbiddenHits: [] };
const shopifyAccount = {
  platform: 'shopify', status: 'active', username: 'merchant_helper', adsPowerProfileId: 'k1test01',
  dailyCap: 3, minIntervalMinutes: 60, postCountToday: 0, postCountResetAtMs: NOW - 3_600_000, lastPostAtMs: 0,
};

// --- accounts ---------------------------------------------------------------

test('an account with no platform field is a Reddit account — no migration', () => {
  assert.equal(accountPlatform({}), 'reddit');
  assert.equal(accountPlatform(null), 'reddit');
  assert.equal(accountPlatform({ platform: 'shopify' }), 'shopify');
  assert.equal(accountPlatform({ platform: 'SHOPIFY' }), 'reddit', 'only the exact value switches platform');
});

test('usernames are cleaned the way each platform writes them', () => {
  assert.equal(cleanUsername('u/budget_lee', 'reddit'), 'budget_lee');
  assert.equal(cleanUsername('/u/budget_lee', 'reddit'), 'budget_lee');
  assert.equal(cleanUsername('@merchant_helper', 'shopify'), 'merchant_helper');
  assert.equal(cleanUsername('https://community.shopify.com/u/merchant_helper/summary', 'shopify'), 'merchant_helper');
  assert.equal(cleanUsername('u/not-stripped-on-shopify', 'shopify'), 'u/not-stripped-on-shopify');
  assert.equal(handleOf('shopify', 'x'), '@x');
  assert.equal(handleOf('reddit', 'x'), 'u/x');
});

// --- the draft ----------------------------------------------------------------

test('only an approved, non-empty, long-enough draft is postable', () => {
  assert.equal(draftRefusal(approved, []), null);
  assert.match(draftRefusal({ ...approved, status: 'pending' }, []), /Approve/);
  assert.match(draftRefusal({ ...approved, status: 'posted' }, []), /already been posted/);
  assert.match(draftRefusal({ ...approved, text: '   ' }, []), /empty/);
  assert.match(draftRefusal({ ...approved, text: 'too short' }, []), /20 characters/);
});

test('a phrase forbidden AFTER the draft was written still stops it', () => {
  assert.match(draftRefusal(approved, ['comfortably']), /forbidden phrase \(comfortably\)/);
  assert.match(draftRefusal({ ...approved, forbiddenHits: ['stored hit'] }, []), /stored hit/);
});

// --- the account ----------------------------------------------------------------

test('a Reddit account is never used for a Shopify post', () => {
  assert.match(accountRefusal({ ...shopifyAccount, platform: undefined }, NOW), /not a Shopify Community account/);
  assert.equal(accountRefusal(shopifyAccount, NOW), null);
});

test('a Shopify account needs a profile, a username, and room in its rails', () => {
  assert.match(accountRefusal({ ...shopifyAccount, adsPowerProfileId: '' }, NOW), /AdsPower profile/);
  assert.match(accountRefusal({ ...shopifyAccount, username: '' }, NOW), /username/);
  assert.match(accountRefusal({ ...shopifyAccount, status: 'banned' }, NOW), /banned/i);
  assert.ok(accountRefusal({ ...shopifyAccount, postCountToday: 3 }, NOW), 'daily cap reached still posted');
  assert.ok(accountRefusal({ ...shopifyAccount, lastPostAtMs: NOW - 10 * 60_000 }, NOW), 'inside the interval still posted');
});

// --- the agent ----------------------------------------------------------------

test('an agent that lists shopify, written by the running process, may take the job', () => {
  assert.equal(agentRefusal({ platforms: ['reddit', 'shopify'], pid: 40850, platformsPid: 40850 }), null);
});

test('an older agent is refused — no list, or a STALE list from an earlier process', () => {
  assert.match(agentRefusal(null), /No posting agent has ever connected/);
  assert.match(agentRefusal({ pid: 38294 }), /cannot post to the Shopify Community/);
  // The dangerous one: a newer agent ran, wrote platforms, then an older agent
  // started and merge-writes the same doc without touching the field.
  assert.match(agentRefusal({ platforms: ['reddit', 'shopify'], pid: 51111, platformsPid: 40850 }), /Restart it/);
  assert.match(agentRefusal({ platforms: ['reddit'], pid: 1, platformsPid: 1 }), /cannot post/);
});

// --- forum standing ----------------------------------------------------------

test('a forum user parses; a missing user is an error, not zeros', () => {
  const s = parseForumUser({ user: { trust_level: 1, badge_count: 4, time_read: 7200, created_at: '2025-01-02T00:00:00.000Z' } }, NOW);
  assert.deepEqual(s, { trustLevel: 1, badgeCount: 4, timeReadSec: 7200, joinedAtMs: Date.UTC(2025, 0, 2), fetchedAtMs: NOW });
  assert.throws(() => parseForumUser({ errors: ['not found'] }, NOW), ForumUserNotFound);
  assert.match(trustLevelNote(0), /links and replies are capped/);
  assert.match(trustLevelNote(null), /not read/);
});
