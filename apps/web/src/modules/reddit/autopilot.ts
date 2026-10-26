// Warm-up autopilot — the rules that plan an account's day by themselves.
//
// PURE. No I/O, no clock: `nowMs` and the random source are passed in, so a
// whole year of days can be planned in a test.
//
// The shape, as agreed with the operator (2026-10-26):
//   - Every account climbs a LADDER of stages by calendar day since its warm-up
//     began (`warmupStartedAt`). Each stage says how many sessions a day and
//     whether joining communities is allowed. Comments arrive in step 2.
//   - Once a day, in the account's own time zone, the day is planned: N sessions
//     at irregular times inside the waking hours, at least MIN_GAP apart, and
//     now and then no activity at all (a person has days off).
//   - Sessions are queued straight away with a start time (`notBeforeMs`); the
//     agent does not claim one before it is due, and Engage wakes the sleeping
//     server for it.
//
// Every number is a setting (agents/autopilot), edited on Settings → Autopilot.
// What is hard-coded here is only shape: sessions never overlap, never fall
// outside the waking hours, and the plan for a day is made once.
//
// Separately, nothing here ever stops an operator posting a client reply from
// any account, however new. The autopilot plans warm-up only.

export interface AutopilotStage {
  name: string;
  /** First calendar day of warm-up this stage applies from (1 = the first day). */
  fromDay: number;
  sessionsMin: number;
  sessionsMax: number;
  /** May sessions join communities tagged Follow? */
  follow: boolean;
}

export interface AutopilotSettings {
  stages: AutopilotStage[];
  /** Local wall-clock window, "HH:MM", in the account's time zone. */
  wakeStart: string;
  wakeEnd: string;
  /** Chance (0–1) a day has no warm-up at all. */
  skipDayChance: number;
  /** Chance (0–1) that one of a day's sessions is a joining session, when the
   *  stage allows it and there is something left to join. */
  followSessionChance: number;
  /** Used for an account until it has a time zone of its own. */
  defaultTimezone: string;
}

export const DEFAULT_AUTOPILOT: AutopilotSettings = {
  stages: [
    { name: 'Settle', fromDay: 1, sessionsMin: 1, sessionsMax: 2, follow: false },
    { name: 'Lurker', fromDay: 4, sessionsMin: 2, sessionsMax: 3, follow: true },
    { name: 'First words', fromDay: 8, sessionsMin: 2, sessionsMax: 4, follow: true },
    { name: 'Regular', fromDay: 15, sessionsMin: 2, sessionsMax: 4, follow: true },
  ],
  wakeStart: '08:00',
  wakeEnd: '23:30',
  skipDayChance: 1 / 7,
  followSessionChance: 0.45,
  defaultTimezone: 'Europe/London',
};

/** Two sessions are never closer than this. */
export const MIN_GAP_MS = 75 * 60_000;
/** A session is never planned in the next few minutes — there must be time to
 *  wake the server (3–5 min) before it is due. */
export const LEAD_MS = 10 * 60_000;

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const num = (v: unknown, min: number, max: number, dflt: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
};

export function isTimezone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Untrusted input → valid settings. Unknown keys are dropped, numbers clamped,
 *  stages sorted and de-duplicated, the first stage always starting on day 1. */
export function normalizeAutopilot(raw: unknown): AutopilotSettings {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const D = DEFAULT_AUTOPILOT;
  const rawStages = Array.isArray(o.stages) ? o.stages : D.stages;
  const stages = rawStages
    .slice(0, 8)
    .map((s, i) => {
      const x = (s && typeof s === 'object' ? s : {}) as Record<string, unknown>;
      const sessionsMin = Math.round(num(x.sessionsMin, 0, 8, 1));
      return {
        name: String(x.name ?? `Stage ${i + 1}`).trim().slice(0, 40) || `Stage ${i + 1}`,
        fromDay: Math.round(num(x.fromDay, 1, 365, 1)),
        sessionsMin,
        sessionsMax: Math.max(sessionsMin, Math.round(num(x.sessionsMax, 0, 8, sessionsMin))),
        follow: x.follow === true,
      };
    })
    .sort((a, b) => a.fromDay - b.fromDay)
    .filter((s, i, all) => i === 0 || s.fromDay !== all[i - 1].fromDay);
  if (!stages.length) stages.push({ ...D.stages[0] });
  stages[0].fromDay = 1;
  let wakeStart = HHMM.test(String(o.wakeStart)) ? String(o.wakeStart) : D.wakeStart;
  let wakeEnd = HHMM.test(String(o.wakeEnd)) ? String(o.wakeEnd) : D.wakeEnd;
  if (minutesOf(wakeEnd) <= minutesOf(wakeStart)) [wakeStart, wakeEnd] = [D.wakeStart, D.wakeEnd];
  return {
    stages,
    wakeStart,
    wakeEnd,
    skipDayChance: num(o.skipDayChance, 0, 0.9, D.skipDayChance),
    followSessionChance: num(o.followSessionChance, 0, 1, D.followSessionChance),
    defaultTimezone: isTimezone(o.defaultTimezone) ? o.defaultTimezone : D.defaultTimezone,
  };
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/** The stage for a calendar day of warm-up (1-based). */
export function stageFor(settings: AutopilotSettings, day: number): { index: number; stage: AutopilotStage } {
  let index = 0;
  settings.stages.forEach((s, i) => {
    if (day >= s.fromDay) index = i;
  });
  return { index, stage: settings.stages[index] };
}

// ---- Time zones, without a library ----

/** The wall-clock parts of an instant in a time zone. */
function partsIn(tz: string, ms: number) {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute };
}

/** "2026-10-26" — the account's own calendar date. */
export function localDate(tz: string, ms: number): string {
  const p = partsIn(tz, ms);
  return `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

/** The instant a local wall-clock time happens on a local date. Two passes
 *  settle the offset, daylight-saving days included. */
export function instantOf(tz: string, date: string, minutes: number): number {
  const [y, mo, d] = date.split('-').map(Number);
  const wall = Date.UTC(y, mo - 1, d, Math.floor(minutes / 60), minutes % 60);
  let guess = wall;
  for (let i = 0; i < 2; i += 1) {
    const p = partsIn(tz, guess);
    const seen = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi);
    guess += wall - seen;
  }
  return guess;
}

// ---- Planning a day ----

export type PlannedKind = 'browse' | 'follow';

export interface PlannedSession {
  atMs: number;
  kind: PlannedKind;
}

export interface DayPlan {
  date: string;
  stageIndex: number;
  stageName: string;
  /** True when the day was rolled as a day off. */
  skipped: boolean;
  sessions: PlannedSession[];
}

/**
 * Plan one local day for one account.
 *
 * Sessions fall inside the waking hours, at least MIN_GAP_MS apart, none before
 * `nowMs + LEAD_MS` — so planning late in the day yields the rest of the day,
 * not a burst. `canFollow` is false when nothing is left to join; then no
 * joining session is planned whatever the stage says.
 */
export function planDay(input: {
  settings: AutopilotSettings;
  timezone: string;
  nowMs: number;
  /** Calendar day of warm-up for this date (1 = first day). */
  warmupDay: number;
  canFollow: boolean;
  random: () => number;
}): DayPlan {
  const { settings, timezone, nowMs, warmupDay, canFollow, random } = input;
  const date = localDate(timezone, nowMs);
  const { index, stage } = stageFor(settings, warmupDay);
  const base = { date, stageIndex: index, stageName: stage.name };
  if (random() < settings.skipDayChance) return { ...base, skipped: true, sessions: [] };

  const want = stage.sessionsMin + Math.floor(random() * (stage.sessionsMax - stage.sessionsMin + 1));
  const start = Math.max(instantOf(timezone, date, minutesOf(settings.wakeStart)), nowMs + LEAD_MS);
  const end = instantOf(timezone, date, minutesOf(settings.wakeEnd));
  const times: number[] = [];
  // Rejection sampling: random instants in the window, kept only when clear of
  // every other session. Bounded, so a window too short for `want` sessions
  // simply yields fewer.
  for (let tries = 0; times.length < want && tries < 200 && end > start; tries += 1) {
    const t = start + Math.floor(random() * (end - start));
    if (times.every((x) => Math.abs(x - t) >= MIN_GAP_MS)) times.push(t);
  }
  times.sort((a, b) => a - b);

  const followAt = stage.follow && canFollow && times.length && random() < settings.followSessionChance ? Math.floor(random() * times.length) : -1;
  return {
    ...base,
    skipped: false,
    sessions: times.map((atMs, i) => ({ atMs, kind: i === followAt ? 'follow' : 'browse' })),
  };
}

/** Is the day due to be planned? Once per local date, and not before the
 *  waking hours are near (an hour ahead), so a day is planned in the morning,
 *  not at midnight. */
export function dayNeedsPlan(input: { settings: AutopilotSettings; timezone: string; nowMs: number; lastPlannedDate: string }): boolean {
  const { settings, timezone, nowMs, lastPlannedDate } = input;
  const today = localDate(timezone, nowMs);
  if (lastPlannedDate === today) return false;
  const wakeAt = instantOf(timezone, today, minutesOf(settings.wakeStart));
  const endAt = instantOf(timezone, today, minutesOf(settings.wakeEnd));
  return nowMs >= wakeAt - 60 * 60_000 && nowMs < endAt;
}
