// Account warm-up designer — domain model, action/package catalogue, and a
// deterministic human-like plan composer.
//
// A "warm-up" is a multi-day schedule of low-stakes Reddit activity that ages a
// fresh account into a plausible, trusted one before it ever posts a brand
// reply: browse, read, join subreddits, occasionally upvote — the ordinary
// footprint of a real lurker, ramping up over days.
//
// This file is deliberately PURE and side-effect free (no 'server-only', no
// Firestore, no fetch) so it runs identically on the server (AI generation,
// validation) and in the browser (the blank-slate designer builds packages
// client-side). NONE of these actions execute anything yet — this is the
// planner. Wiring each action type to a real AdsPower/Reddit step is a later
// pass; the `type` discriminator is the seam it will hook into.

// ---------------------------------------------------------------------------
// Atomic actions
// ---------------------------------------------------------------------------

export type WarmupActionType =
  | 'browse_home' // land on the home feed
  | 'scroll_feed' // scroll a while, as if skimming
  | 'open_post' // click into a post
  | 'read_dwell' // sit on a post/comments as if reading
  | 'open_subreddit' // navigate to a subreddit
  | 'search_keyword' // use search — the query pulls known subreddits
  | 'expand_comments' // open/expand a comment thread
  | 'upvote_post' // upvote the current post
  | 'upvote_comment' // upvote a comment
  | 'save_post' // save/bookmark a post
  | 'follow_post' // follow a post for updates
  | 'join_subreddit' // join a subreddit (starts populating the home feed)
  | 'view_profile' // look at another user's profile
  | 'idle'; // do nothing — away from the app

export type WarmupCategory = 'browse' | 'engage' | 'discover' | 'idle';

export interface WarmupActionDef {
  type: WarmupActionType;
  label: string;
  category: WarmupCategory;
  /** Plausible dwell/execution time range, seconds [min, max]. */
  dwell: [number, number];
  /** Optional free-text params this action carries (keyword, subreddit, …). */
  paramKeys?: string[];
}

export const WARMUP_ACTIONS: Record<WarmupActionType, WarmupActionDef> = {
  browse_home: { type: 'browse_home', label: 'Browse home feed', category: 'browse', dwell: [20, 90] },
  scroll_feed: { type: 'scroll_feed', label: 'Scroll the feed', category: 'browse', dwell: [15, 70] },
  open_post: { type: 'open_post', label: 'Open a post', category: 'browse', dwell: [3, 9] },
  read_dwell: { type: 'read_dwell', label: 'Read (dwell)', category: 'browse', dwell: [30, 160] },
  open_subreddit: { type: 'open_subreddit', label: 'Open a subreddit', category: 'discover', dwell: [4, 14], paramKeys: ['subreddit'] },
  search_keyword: { type: 'search_keyword', label: 'Search a keyword', category: 'discover', dwell: [6, 20], paramKeys: ['keyword'] },
  expand_comments: { type: 'expand_comments', label: 'Expand comments', category: 'engage', dwell: [10, 50] },
  upvote_post: { type: 'upvote_post', label: 'Upvote a post', category: 'engage', dwell: [1, 3] },
  upvote_comment: { type: 'upvote_comment', label: 'Upvote a comment', category: 'engage', dwell: [1, 3] },
  save_post: { type: 'save_post', label: 'Save a post', category: 'engage', dwell: [1, 3] },
  follow_post: { type: 'follow_post', label: 'Follow a post', category: 'engage', dwell: [1, 3] },
  join_subreddit: { type: 'join_subreddit', label: 'Join a subreddit', category: 'engage', dwell: [2, 5], paramKeys: ['subreddit'] },
  view_profile: { type: 'view_profile', label: 'View a profile', category: 'browse', dwell: [8, 30] },
  idle: { type: 'idle', label: 'Idle / away', category: 'idle', dwell: [0, 0] },
};

export const WARMUP_ACTION_LIST: readonly WarmupActionDef[] = Object.values(WARMUP_ACTIONS);

/** One scheduled action on a day's timeline. */
export interface WarmupAction {
  id: string;
  type: WarmupActionType;
  /** Display label; defaults from the catalogue but editable. */
  label: string;
  /** Optional params, e.g. { keyword: 'zero based budgeting' } or { subreddit: 'r/budget' }. */
  params?: Record<string, string>;
  /** How long this action takes, seconds. */
  dwellSec: number;
  /** Gap AFTER this action before the next one, seconds. Within a session this is
   *  short; the last action of a session carries the long "come back later" gap. */
  gapAfterSec: number;
  /** ± randomisation applied to dwell and gap at run time (0–100). */
  jitterPct: number;
  /** Actions sharing a groupId render as one bracketed package and move together.
   *  Set when a package is added or two actions are merged. */
  groupId?: string;
}

/** A named package instance present on a day (the label for a groupId). */
export interface WarmupGroup {
  id: string;
  name: string;
}

export interface WarmupDay {
  day: number; // 1-based
  label: string; // short theme, e.g. "Light lurking"
  actions: WarmupAction[];
  groups: WarmupGroup[];
}

export interface WarmupPlan {
  version: 1;
  source: 'ai' | 'manual';
  days: WarmupDay[];
}

// ---------------------------------------------------------------------------
// Packages — pre-built, human-like sequences
// ---------------------------------------------------------------------------

export type WarmupPackageId =
  | 'quick_peek'
  | 'casual_browse'
  | 'discover_and_join'
  | 'keyword_hunt'
  | 'sub_catchup'
  | 'light_engage';

interface Seed {
  type: WarmupActionType;
  params?: Record<string, string>;
  /** Include probability (default 1). Lets a package vary run to run. */
  chance?: number;
}

export interface WarmupPackageDef {
  id: WarmupPackageId;
  name: string;
  description: string;
  category: 'browse' | 'discover' | 'engage';
  /** The ordered micro-actions. `chance` < 1 makes a step occasional. */
  seeds: Seed[];
}

// The flows the user described: browse home → open a post → read → maybe join or
// like; and: search a keyword → land on a subreddit → scroll → open a post →
// expand → follow → sometimes upvote. Optional steps keep instances from looking
// identical.
export const WARMUP_PACKAGES: Record<WarmupPackageId, WarmupPackageDef> = {
  quick_peek: {
    id: 'quick_peek',
    name: 'Quick peek',
    description: 'A short glance at the home feed, then away. The lightest footprint.',
    category: 'browse',
    seeds: [{ type: 'browse_home' }, { type: 'scroll_feed' }, { type: 'idle' }],
  },
  casual_browse: {
    id: 'casual_browse',
    name: 'Casual browse',
    description: 'Land on the homepage, scroll, open a post, read a while, maybe upvote.',
    category: 'browse',
    seeds: [
      { type: 'browse_home' },
      { type: 'scroll_feed' },
      { type: 'open_post' },
      { type: 'read_dwell' },
      { type: 'upvote_post', chance: 0.4 },
      { type: 'scroll_feed', chance: 0.5 },
    ],
  },
  discover_and_join: {
    id: 'discover_and_join',
    name: 'Discover & join',
    description: 'Browse, read a post that fits the persona, then join that subreddit.',
    category: 'discover',
    seeds: [
      { type: 'browse_home' },
      { type: 'open_post' },
      { type: 'read_dwell' },
      { type: 'expand_comments', chance: 0.5 },
      { type: 'join_subreddit' },
    ],
  },
  keyword_hunt: {
    id: 'keyword_hunt',
    name: 'Keyword discovery',
    description: 'Search a keyword that surfaces target subs, scroll, open a post, expand, follow, sometimes like.',
    category: 'discover',
    seeds: [
      { type: 'search_keyword' },
      { type: 'open_subreddit' },
      { type: 'scroll_feed' },
      { type: 'open_post' },
      { type: 'expand_comments' },
      { type: 'upvote_comment', chance: 0.4 },
      { type: 'follow_post' },
      { type: 'join_subreddit', chance: 0.35 },
    ],
  },
  sub_catchup: {
    id: 'sub_catchup',
    name: 'Followed-sub catch-up',
    description: 'Open a subreddit the account follows, scroll, read a post, maybe upvote or save.',
    category: 'browse',
    seeds: [
      { type: 'open_subreddit' },
      { type: 'scroll_feed' },
      { type: 'open_post' },
      { type: 'read_dwell' },
      { type: 'upvote_post', chance: 0.5 },
      { type: 'save_post', chance: 0.25 },
    ],
  },
  light_engage: {
    id: 'light_engage',
    name: 'Light engagement',
    description: 'Open a post, read, upvote, expand the thread, occasionally upvote a comment.',
    category: 'engage',
    seeds: [
      { type: 'open_post' },
      { type: 'read_dwell' },
      { type: 'upvote_post' },
      { type: 'expand_comments' },
      { type: 'upvote_comment', chance: 0.5 },
    ],
  },
};

export const WARMUP_PACKAGE_LIST: readonly WarmupPackageDef[] = Object.values(WARMUP_PACKAGES);

// ---------------------------------------------------------------------------
// Instantiation helpers (browser + server)
// ---------------------------------------------------------------------------

let counter = 0;
/** Non-crypto unique id; fine for local plan-item identity. */
export function warmupId(prefix = 'a'): string {
  counter = (counter + 1) % 1e6;
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}${counter.toString(36)}`;
}

const randInt = (min: number, max: number) => Math.floor(min + Math.random() * (max - min + 1));

/** Build one concrete action from a catalogue type. */
export function makeAction(type: WarmupActionType, overrides: Partial<WarmupAction> = {}): WarmupAction {
  const def = WARMUP_ACTIONS[type];
  const [lo, hi] = def.dwell;
  return {
    id: warmupId(),
    type,
    label: def.label,
    dwellSec: overrides.dwellSec ?? randInt(lo, hi),
    // Within-session micro-gap between clicks; the composer overrides the last
    // action's gap with a long between-session pause.
    gapAfterSec: overrides.gapAfterSec ?? randInt(4, 30),
    jitterPct: overrides.jitterPct ?? 30,
    ...(overrides.params ? { params: overrides.params } : {}),
    ...(overrides.groupId ? { groupId: overrides.groupId } : {}),
  };
}

/** Expand a package into a grouped run of concrete actions. */
export function instantiatePackage(id: WarmupPackageId): { actions: WarmupAction[]; group: WarmupGroup } {
  const def = WARMUP_PACKAGES[id];
  const group: WarmupGroup = { id: warmupId('g'), name: def.name };
  const actions = def.seeds
    .filter((s) => s.chance === undefined || Math.random() < s.chance)
    .map((s) => makeAction(s.type, { groupId: group.id, ...(s.params ? { params: s.params } : {}) }));
  // A package with everything filtered out is degenerate — guarantee ≥1 action.
  if (actions.length === 0) actions.push(makeAction(def.seeds[0].type, { groupId: group.id }));
  return { actions, group };
}

// ---------------------------------------------------------------------------
// Deterministic-ish composer — the "auto design" / AI fallback
// ---------------------------------------------------------------------------

/** Session gap in seconds — accounts come back after a few hours, not minutes. */
function sessionGap(): number {
  return randInt(45, 300) * 60; // 45min – 5h
}

/** Weighted pick from [id, weight] pairs. */
function weightedPick<T>(pairs: [T, number][]): T {
  const total = pairs.reduce((s, [, w]) => s + w, 0);
  let r = Math.random() * total;
  for (const [v, w] of pairs) {
    r -= w;
    if (r <= 0) return v;
  }
  return pairs[pairs.length - 1][0];
}

/** Package mix per phase of the warm-up — lurk first, engage later. */
function phaseMix(phase: 'early' | 'mid' | 'late'): [WarmupPackageId, number][] {
  if (phase === 'early')
    return [
      ['quick_peek', 5],
      ['casual_browse', 5],
      ['discover_and_join', 2],
    ];
  if (phase === 'mid')
    return [
      ['casual_browse', 4],
      ['sub_catchup', 4],
      ['discover_and_join', 3],
      ['keyword_hunt', 3],
      ['quick_peek', 2],
    ];
  return [
    ['keyword_hunt', 4],
    ['sub_catchup', 4],
    ['light_engage', 3],
    ['casual_browse', 3],
    ['discover_and_join', 2],
  ];
}

const PHASE_LABEL: Record<'early' | 'mid' | 'late', string> = {
  early: 'Light lurking',
  mid: 'Browsing & joining',
  late: 'Active & engaging',
};

/** Phase labels in ramp order [early, mid, late] — handy for indexing by day. */
export const PHASE_LABEL_LIST: readonly string[] = [PHASE_LABEL.early, PHASE_LABEL.mid, PHASE_LABEL.late];

/** Optionally supply real keywords/subreddits/persona to bake into actions. */
export interface WarmupComposeContext {
  keywords?: string[];
  subreddits?: string[];
  persona?: string;
}

function fillParams(action: WarmupAction, ctx: WarmupComposeContext): WarmupAction {
  const def = WARMUP_ACTIONS[action.type];
  if (!def.paramKeys) return action;
  const params = { ...(action.params ?? {}) };
  if (def.paramKeys.includes('keyword') && ctx.keywords?.length && !params.keyword) {
    params.keyword = ctx.keywords[randInt(0, ctx.keywords.length - 1)];
  }
  if (def.paramKeys.includes('subreddit') && ctx.subreddits?.length && !params.subreddit) {
    params.subreddit = ctx.subreddits[randInt(0, ctx.subreddits.length - 1)];
  }
  return Object.keys(params).length ? { ...action, params } : action;
}

/** Fill keyword/subreddit params across an entire plan (used after AI expands). */
export function fillPlanParams(plan: WarmupPlan, ctx: WarmupComposeContext): WarmupPlan {
  if (!ctx.keywords?.length && !ctx.subreddits?.length) return plan;
  return {
    ...plan,
    days: plan.days.map((d) => ({ ...d, actions: d.actions.map((a) => fillParams(a, ctx)) })),
  };
}

/**
 * Compose a full multi-day plan. Ramps intensity across the run and weights
 * packages by phase, so early days lurk and later days engage — the shape a
 * human account naturally takes as its feed fills from followed subs.
 *
 * Used directly as the "auto design", and as the fallback when AI generation is
 * unavailable. Pure + randomised (Math.random), so each call differs.
 */
export function composeWarmupPlan(days: number, ctx: WarmupComposeContext = {}): WarmupPlan {
  const n = Math.max(1, Math.min(60, Math.round(days) || 1));
  const out: WarmupDay[] = [];

  for (let day = 1; day <= n; day++) {
    const frac = n === 1 ? 0.5 : (day - 1) / (n - 1);
    const phase: 'early' | 'mid' | 'late' = frac < 0.34 ? 'early' : frac < 0.7 ? 'mid' : 'late';
    // Sessions ramp ~1–2 early to ~4–5 late, with a little noise.
    const base = 1 + Math.round(frac * 3);
    const sessions = Math.max(1, Math.min(6, base + randInt(0, 1)));

    const actions: WarmupAction[] = [];
    const groups: WarmupGroup[] = [];
    for (let s = 0; s < sessions; s++) {
      const pkg = weightedPick(phaseMix(phase));
      const { actions: pkgActions, group } = instantiatePackage(pkg);
      groups.push(group);
      const filled = pkgActions.map((a) => fillParams(a, ctx));
      // Long gap AFTER the session (except the last of the day).
      filled[filled.length - 1].gapAfterSec = s < sessions - 1 ? sessionGap() : 0;
      actions.push(...filled);
    }

    out.push({ day, label: PHASE_LABEL[phase], actions, groups });
  }

  return { version: 1, source: 'ai', days: out };
}

/** An empty N-day skeleton for the blank-slate designer. */
export function blankWarmupPlan(days: number): WarmupPlan {
  const n = Math.max(1, Math.min(60, Math.round(days) || 1));
  return {
    version: 1,
    source: 'manual',
    days: Array.from({ length: n }, (_, i) => ({ day: i + 1, label: '', actions: [], groups: [] })),
  };
}

// ---------------------------------------------------------------------------
// Validation / normalisation (server trusts nothing from the client)
// ---------------------------------------------------------------------------

const clampInt = (v: unknown, lo: number, hi: number, dflt: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
};

function normalizeAction(raw: unknown): WarmupAction | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const type = r.type as WarmupActionType;
  if (!(type in WARMUP_ACTIONS)) return null;
  const def = WARMUP_ACTIONS[type];

  let params: Record<string, string> | undefined;
  if (r.params && typeof r.params === 'object') {
    const p: Record<string, string> = {};
    for (const [k, v] of Object.entries(r.params as Record<string, unknown>)) {
      if (typeof v === 'string' && v.trim()) p[k] = v.trim().slice(0, 200);
    }
    if (Object.keys(p).length) params = p;
  }

  return {
    id: typeof r.id === 'string' && r.id ? r.id.slice(0, 40) : warmupId(),
    type,
    label: typeof r.label === 'string' && r.label.trim() ? r.label.trim().slice(0, 120) : def.label,
    dwellSec: clampInt(r.dwellSec, 0, 3600, 30),
    gapAfterSec: clampInt(r.gapAfterSec, 0, 86400, 0),
    jitterPct: clampInt(r.jitterPct, 0, 100, 30),
    ...(params ? { params } : {}),
    ...(typeof r.groupId === 'string' && r.groupId ? { groupId: r.groupId.slice(0, 40) } : {}),
  };
}

/**
 * Coerce arbitrary client input into a safe WarmupPlan. Drops anything unknown
 * rather than trusting it — the client can propose a plan, but the shape and
 * bounds are enforced here. Returns null if it isn't a usable plan at all.
 */
export function normalizeWarmupPlan(raw: unknown): WarmupPlan | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.days)) return null;

  const days: WarmupDay[] = r.days.slice(0, 60).map((d, i) => {
    const dd = (d ?? {}) as Record<string, unknown>;
    const actions = Array.isArray(dd.actions)
      ? (dd.actions.map(normalizeAction).filter(Boolean) as WarmupAction[]).slice(0, 200)
      : [];
    const usedGroupIds = new Set(actions.map((a) => a.groupId).filter(Boolean));
    const groups = Array.isArray(dd.groups)
      ? (dd.groups as unknown[])
          .map((g) => (g && typeof g === 'object' ? (g as Record<string, unknown>) : null))
          .filter((g): g is Record<string, unknown> => !!g && typeof g.id === 'string' && usedGroupIds.has(g.id as string))
          .map((g) => ({ id: (g.id as string).slice(0, 40), name: String(g.name ?? 'Package').slice(0, 80) }))
      : [];
    return {
      day: clampInt(dd.day, 1, 60, i + 1),
      label: typeof dd.label === 'string' ? dd.label.trim().slice(0, 80) : '',
      actions,
      groups,
    };
  });

  if (days.length === 0) return null;
  const source = r.source === 'manual' ? 'manual' : 'ai';
  return { version: 1, source, days };
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/** "45s", "12m", "2h 5m" from seconds. */
export function humanizeDuration(sec: number): string {
  if (sec <= 0) return '0s';
  if (sec < 60) return `${sec}s`;
  const m = Math.round(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? `${h}h ${rem}m` : `${h}h`;
}

/** Total wall-clock a day spans (dwell + gaps), seconds. */
export function dayDurationSec(day: WarmupDay): number {
  return day.actions.reduce((s, a) => s + a.dwellSec + a.gapAfterSec, 0);
}
