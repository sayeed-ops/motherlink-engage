// When a warming Reddit account becomes active: 21 days and 10 warm-up days.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  countWarmupDays,
  READY_AFTER_DAYS,
  READY_WARMUP_DAYS,
  warmupReadiness,
} from '../../apps/web/src/modules/reddit/warmupReadiness.ts';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 30, 12);

test('the rule is 21 days of age and 10 days of warm-up', () => {
  assert.equal(READY_AFTER_DAYS, 21);
  assert.equal(READY_WARMUP_DAYS, 10);
});

test('both clocks are required', () => {
  assert.equal(warmupReadiness(NOW - 21 * DAY, 10, NOW).ready, true);
  assert.equal(warmupReadiness(NOW - 21 * DAY, 9, NOW).ready, false);
  assert.equal(warmupReadiness(NOW - 20 * DAY, 10, NOW).ready, false);
  assert.equal(warmupReadiness(NOW - 90 * DAY, 0, NOW).ready, false);
});

test('age counts full days only', () => {
  assert.equal(warmupReadiness(NOW - 21 * DAY + 1, 10, NOW).ageDays, 20);
  assert.equal(warmupReadiness(NOW - 21 * DAY + 1, 10, NOW).ready, false);
});

test('an account with no creation date is never ready', () => {
  assert.deepEqual(warmupReadiness(0, 50, NOW), { ageDays: 0, warmupDays: 50, ready: false });
});

test('several sessions on one day count once', () => {
  const runs = [{ ranAtMs: NOW }, { ranAtMs: NOW + 1000 }, { ranAtMs: NOW - DAY }];
  assert.equal(countWarmupDays(runs, 'UTC'), 2);
});

test('dry runs and undated runs earn nothing', () => {
  const runs = [{ ranAtMs: NOW, dryRun: true }, { ranAtMs: 0 }, { ranAtMs: NOW - DAY, dryRun: false }];
  assert.equal(countWarmupDays(runs, 'UTC'), 1);
});

test('days follow the account time zone', () => {
  // 03:00 and 05:00 UTC are one day in UTC, but either side of midnight in New York.
  const runs = [{ ranAtMs: Date.UTC(2026, 9, 30, 3) }, { ranAtMs: Date.UTC(2026, 9, 30, 5) }];
  assert.equal(countWarmupDays(runs, 'UTC'), 1);
  assert.equal(countWarmupDays(runs, 'America/New_York'), 2);
});
