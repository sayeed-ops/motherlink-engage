// The warm-up autopilot's day planner — many days, many time zones.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_AUTOPILOT, LEAD_MS, MIN_GAP_MS,
  dayNeedsPlan, instantOf, localDate, normalizeAutopilot, planDay, stageFor,
} from '../../apps/web/src/modules/reddit/autopilot.ts';

const S = DEFAULT_AUTOPILOT;
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
const minutesLocal = (tz, ms) => {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms));
  return +p.find((x) => x.type === 'hour').value * 60 + +p.find((x) => x.type === 'minute').value;
};

test('stages by calendar day: 1–3 Settle, 4–7 Lurker, 8–14 First words, 15+ Regular', () => {
  const names = [1, 3, 4, 7, 8, 14, 15, 90].map((d) => stageFor(S, d).stage.name);
  assert.deepEqual(names, ['Settle', 'Settle', 'Lurker', 'Lurker', 'First words', 'First words', 'Regular', 'Regular']);
});

test('local time zones: wall clock round-trips, daylight saving included', () => {
  for (const tz of ['Europe/London', 'America/Chicago', 'Asia/Kolkata', 'Australia/Sydney']) {
    for (const date of ['2026-03-29', '2026-10-25', '2026-07-01']) {
      const ms = instantOf(tz, date, 9 * 60 + 30);
      assert.equal(localDate(tz, ms), date, `${tz} ${date}`);
      assert.equal(minutesLocal(tz, ms), 9 * 60 + 30, `${tz} ${date}`);
    }
  }
});

test('a year of planned days: inside waking hours, never closer than the gap, counts within the stage', () => {
  const tz = 'America/Chicago';
  const r = rng(7);
  let days = 0, skipped = 0, follows = 0;
  for (let i = 0; i < 365; i += 1) {
    const now = instantOf(tz, '2026-01-01', 6 * 60) + i * 86_400_000;
    const day = 1 + (i % 30);
    const plan = planDay({ settings: S, timezone: tz, nowMs: now, warmupDay: day, canFollow: true, random: r });
    days += 1;
    if (plan.skipped) { skipped += 1; continue; }
    const st = stageFor(S, day).stage;
    assert.ok(plan.sessions.length >= Math.min(st.sessionsMin, 1) && plan.sessions.length <= st.sessionsMax);
    for (const s of plan.sessions) {
      const m = minutesLocal(tz, s.atMs);
      assert.ok(m >= 8 * 60 && m <= 23 * 60 + 30, `session at ${m} min`);
      assert.equal(localDate(tz, s.atMs), plan.date);
      if (s.kind === 'follow') { follows += 1; assert.ok(st.follow); }
    }
    for (let k = 1; k < plan.sessions.length; k += 1) assert.ok(plan.sessions[k].atMs - plan.sessions[k - 1].atMs >= MIN_GAP_MS);
  }
  assert.ok(skipped / days > 0.08 && skipped / days < 0.22, `skip rate ${skipped / days}`);
  assert.ok(follows > 50, `follow sessions ${follows}`);
});

test('Settle never joins, and nothing joins when nothing is left to join', () => {
  const r = rng(3);
  for (let i = 0; i < 200; i += 1) {
    const now = instantOf('Europe/London', '2026-05-01', 7 * 60) + i * 86_400_000;
    assert.ok(planDay({ settings: S, timezone: 'Europe/London', nowMs: now, warmupDay: 2, canFollow: true, random: r }).sessions.every((s) => s.kind === 'browse'));
    assert.ok(planDay({ settings: S, timezone: 'Europe/London', nowMs: now, warmupDay: 20, canFollow: false, random: r }).sessions.every((s) => s.kind === 'browse'));
  }
});

test('planning late in the day only uses what is left of it, never the next few minutes', () => {
  const tz = 'Europe/London';
  const now = instantOf(tz, '2026-06-10', 21 * 60);
  for (let i = 0; i < 100; i += 1) {
    const p = planDay({ settings: S, timezone: tz, nowMs: now, warmupDay: 20, canFollow: true, random: rng(i) });
    for (const s of p.sessions) assert.ok(s.atMs >= now + LEAD_MS && localDate(tz, s.atMs) === '2026-06-10');
  }
});

test('a day is planned once, from an hour before waking until the waking hours end', () => {
  const tz = 'Asia/Kolkata';
  const at = (m) => instantOf(tz, '2026-06-10', m);
  assert.equal(dayNeedsPlan({ settings: S, timezone: tz, nowMs: at(5 * 60), lastPlannedDate: '' }), false);
  assert.equal(dayNeedsPlan({ settings: S, timezone: tz, nowMs: at(7 * 60 + 15), lastPlannedDate: '' }), true);
  assert.equal(dayNeedsPlan({ settings: S, timezone: tz, nowMs: at(12 * 60), lastPlannedDate: '2026-06-10' }), false);
  assert.equal(dayNeedsPlan({ settings: S, timezone: tz, nowMs: at(23 * 60 + 45), lastPlannedDate: '2026-06-09' }), false);
});

test('settings from the page are cleaned: clamped, sorted, first stage on day 1, bad hours and zones fall back', () => {
  const s = normalizeAutopilot({
    stages: [{ name: 'B', fromDay: 9, sessionsMin: 5, sessionsMax: 2, follow: true }, { name: 'A', fromDay: 3, sessionsMin: -2, sessionsMax: 99 }],
    wakeStart: '23:00', wakeEnd: '07:00', skipDayChance: 5, defaultTimezone: 'Mars/Base', junk: 1,
  });
  assert.deepEqual(s.stages.map((x) => [x.name, x.fromDay, x.sessionsMin, x.sessionsMax, x.follow]), [['A', 1, 0, 8, false], ['B', 9, 5, 5, true]]);
  assert.deepEqual([s.wakeStart, s.wakeEnd, s.skipDayChance, s.defaultTimezone], ['08:00', '23:30', 0.9, 'Europe/London']);
  assert.equal('junk' in s, false);
});

// ---- New accounts start with Wasim.2's comment settings ----

import { accountCommentSettings, DEFAULT_COMMENT_SETTINGS } from '../../apps/web/src/modules/forum/reply/settings.ts';

test('an account that never saved comment settings starts with the new-account defaults', () => {
  const s = accountCommentSettings(undefined);
  assert.equal(s.enabled, true);
  assert.deepEqual(s.feeds, ['rising', 'hot', 'new']);
  assert.deepEqual([s.limits.minAgeMinutes, s.limits.maxAgeHours, s.limits.maxComments, s.limits.maxTopCommentScore, s.limits.minUpvoteRatio, s.limits.visibleCommentScore], [30, 24, 200, 500, 0.5, 15]);
  assert.deepEqual([s.dailyCap, s.minIntervalMinutes, s.combinedDailyCap, s.maxPerSubredditPerDay, s.maxThreadsPerScan], [3, 90, 6, 4, 8]);
  assert.deepEqual(s.relax, { ignoreGap: true, ignoreOpportunity: true, ignoreBotTell: true, ignoreCritic: true });
  assert.equal(s.autoPost, false);
});

test('saved settings are kept as saved, and the engine baseline is unchanged', () => {
  assert.equal(accountCommentSettings({ enabled: false, feeds: ['hot'] }).enabled, false);
  assert.deepEqual(accountCommentSettings({ enabled: false, feeds: ['hot'] }).feeds, ['hot']);
  assert.equal(DEFAULT_COMMENT_SETTINGS.enabled, false);
  assert.equal(DEFAULT_COMMENT_SETTINGS.limits.maxAgeHours, 6);
});
