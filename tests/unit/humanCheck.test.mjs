// "Prove you are human": an open check stops everything for that account until
// a person marks it solved.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { humanCheckOf, humanCheckRefusal } from '../../apps/web/src/modules/accounts/humanCheck.ts';
import { COMMENT_TYPES, WARMUP_TYPES } from '../../apps/poster-agent/reddit/actions.mjs';
import { HumanCheckError } from '../../apps/poster-agent/reddit/helpers.mjs';

const open = { humanCheck: { status: 'open', reason: 'CAPTCHA', text: 'reCAPTCHA', url: 'https://www.reddit.com/r/x/', jobId: 'j1', kind: 'warmup', detectedAtMs: 1 } };

test('an open check refuses every new job for the account', () => {
  assert.match(humanCheckRefusal(open), /unsolved .*prove you are human/);
});

test('a solved check, or none at all, refuses nothing', () => {
  assert.equal(humanCheckRefusal({ humanCheck: { ...open.humanCheck, status: 'resolved', resolvedAtMs: 2 } }), null);
  assert.equal(humanCheckRefusal({}), null);
  assert.equal(humanCheckRefusal(null), null);
});

test('a check read back from the account is complete and safe to show', () => {
  const c = humanCheckOf(open);
  assert.equal(c.status, 'open');
  assert.equal(c.kind, 'warmup');
  assert.equal(c.resolvedAtMs, null);
  // Anything but an explicit 'open' reads as solved — a malformed record must
  // not block an account forever, and the agent writes 'open' explicitly.
  assert.equal(humanCheckOf({ humanCheck: { status: 'weird' } }).status, 'resolved');
});

test('the error the agent stops on carries what it saw and says what to do', () => {
  const e = new HumanCheckError({ reason: 'CAPTCHA', text: 'reCAPTCHA', url: 'u' });
  assert.equal(e.humanCheck.reason, 'CAPTCHA');
  assert.match(e.message, /mark it solved on the account's page/);
});

test('no browsing vocabulary was widened for this', () => {
  assert.ok(!WARMUP_TYPES.has('post_comment'));
  assert.ok(COMMENT_TYPES.has('post_comment'));
});
