// Which tab a job works in — the rule, without a browser.
//
// Policy, not just units:
//   - a job never takes a tab on another site;
//   - a tab with unsent text is never taken, even the agent's own;
//   - the agent's own tab is only reused while it is still on the site.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onPlatform, pickTab } from '../../apps/poster-agent/tabs.mjs';

const tab = (id, url, dirty = false) => ({ id, url, dirty });

test('hosts: Reddit and its subdomains; the Shopify Community only, not shopify.com', () => {
  assert.ok(onPlatform('https://www.reddit.com/r/shopify/', 'reddit'));
  assert.ok(onPlatform('https://old.reddit.com/', 'reddit'));
  assert.ok(!onPlatform('https://notreddit.com/', 'reddit'));
  assert.ok(onPlatform('https://community.shopify.com/t/x/1', 'shopify'));
  assert.ok(!onPlatform('https://admin.shopify.com/store/x', 'shopify'), 'a store admin tab is never the forum tab');
  assert.ok(!onPlatform('chrome://newtab/', 'reddit'));
  assert.ok(!onPlatform('not a url', 'shopify'));
});

test('a Reddit job takes the Reddit tab, not the first tab', () => {
  const tabs = [tab('a', 'https://community.shopify.com/t/x/1'), tab('b', 'https://www.reddit.com/')];
  assert.deepEqual(pickTab(tabs, null, 'reddit'), { id: 'b', reason: 'platform-tab' });
  assert.deepEqual(pickTab(tabs, null, 'shopify'), { id: 'a', reason: 'platform-tab' });
});

test('no tab on the site → a new tab; other sites are never taken', () => {
  const tabs = [tab('a', 'https://mail.google.com/'), tab('b', 'https://admin.shopify.com/')];
  assert.deepEqual(pickTab(tabs, null, 'shopify'), { id: null, reason: 'new' });
});

test('the agent’s own tab wins over another tab on the site', () => {
  const tabs = [tab('person', 'https://www.reddit.com/r/a'), tab('agent', 'https://www.reddit.com/r/b')];
  assert.deepEqual(pickTab(tabs, 'agent', 'reddit'), { id: 'agent', reason: 'remembered' });
});

test('a tab with unsent text is never taken — not even the agent’s own', () => {
  const tabs = [tab('agent', 'https://www.reddit.com/r/b', true), tab('other', 'https://www.reddit.com/r/c', true)];
  assert.deepEqual(pickTab(tabs, 'agent', 'reddit'), { id: null, reason: 'new' });
  const mixed = [tab('typing', 'https://community.shopify.com/t/1', true), tab('idle', 'https://community.shopify.com/t/2')];
  assert.deepEqual(pickTab(mixed, null, 'shopify'), { id: 'idle', reason: 'platform-tab' });
});

test('the agent’s tab that a person took to another site is theirs now', () => {
  const tabs = [tab('agent', 'https://www.youtube.com/'), tab('r', 'https://www.reddit.com/')];
  assert.deepEqual(pickTab(tabs, 'agent', 'reddit'), { id: 'r', reason: 'platform-tab' });
  assert.deepEqual(pickTab([tab('agent', 'https://www.youtube.com/')], 'agent', 'reddit'), { id: null, reason: 'new' });
});

test('AdsPower’s start page (IP and profile details) is never taken — a job opens a new tab beside it', () => {
  // The operator keeps this tab to check the profile's IP. It is what `pages[0]`
  // used to be, which is how every job used to land on top of it.
  for (const start of ['https://start.adspower.net/', 'https://start.adspower.com/', 'http://127.0.0.1:50325/start']) {
    const tabs = [tab('start', start)];
    assert.deepEqual(pickTab(tabs, null, 'reddit'), { id: null, reason: 'new' }, `${start} taken for reddit`);
    assert.deepEqual(pickTab(tabs, null, 'shopify'), { id: null, reason: 'new' }, `${start} taken for shopify`);
    assert.deepEqual(pickTab(tabs, 'start', 'reddit'), { id: null, reason: 'new' }, 'not even if remembered');
  }
});
