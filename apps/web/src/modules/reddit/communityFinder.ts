// Finding warm-up communities for one account: a persona first, then
// communities that fit the whole person, each checked on its first visit.
//
// PURE: prompts, parsers and the limits. The server calls the model; the agent
// reads a community's sidebar before it joins and applies the same limits.
//
// A PERSON, NOT A KEYWORD. Real people follow their job and a lot that has
// nothing to do with it. Suggestions only have to be plausible for this person
// and never contradict them; most should be hobbies and everyday interests.

import { normalizeKeywordList, normalizeSubredditList } from './subreddits';

/** The community limits, applied by the agent on the visit before joining. */
export const COMMUNITY_LIMITS = {
  maxWeeklyVisitors: 50_000,
  minWeeklyVisitors: 1_000,
  /** Fewer than 3. */
  maxModerators: 2,
} as const;

export interface Persona {
  /** Two or three sentences a stranger would recognise as one person. */
  summary: string;
  ageRange: string;
  occupation: string;
  /** Where they live; follows the account's IP. */
  location: string;
  interests: string[];
  /** Topics this person would never be into. */
  avoid: string[];
}

export type SuggestionKind = 'close' | 'interest' | 'general';

export interface CommunitySuggestion {
  name: string;
  kind: SuggestionKind;
  why: string;
  /** Up to two natural searches, then the name in words. */
  keywords: string[];
}

/** What the agent recorded on the visit. Lives on the account as
 *  `communityChecks.<name>`, apart from the list so saving the list never
 *  touches it. */
export interface CommunityCheck {
  status: 'pending' | 'passed' | 'rejected';
  /** Private, quarantined or adult: never joined. A rejection that is not hard
   *  only rules the community out for comments. */
  hard: boolean;
  reason: string;
  weeklyVisitors: number | null;
  moderators: number | null;
  apps: string[];
  checkedAtMs: number;
}

export const PERSONA_SYSTEM = `You invent a believable, ordinary person who will use a Reddit account. Reply with JSON only.`;

export function buildPersonaPrompt(input: { place: string; hint: string }): string {
  return [
    `Invent one ordinary adult who would plausibly use Reddit.`,
    input.place ? `They live in or near ${input.place}. Make the location fit that.` : `Pick a plausible location.`,
    input.hint.trim() ? `Guidance from the operator: ${input.hint.trim()}` : '',
    `Give them a normal job, an age range, 6 to 10 everyday interests that do not all relate to the job, and 3 to 5 topics they would never be into.`,
    `Nothing famous, extreme, political or adult. No real names.`,
    `JSON shape: {"summary": string, "ageRange": string, "occupation": string, "location": string, "interests": string[], "avoid": string[]}`,
  ]
    .filter(Boolean)
    .join('\n');
}

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, max) : '');
const list = (v: unknown, max: number, each = 60) =>
  Array.isArray(v) ? [...new Set(v.map((x) => text(x, each)).filter(Boolean))].slice(0, max) : [];

export function parsePersona(raw: unknown): Persona | null {
  const o = raw as Record<string, unknown> | null;
  if (!o || typeof o !== 'object') return null;
  const persona: Persona = {
    summary: text(o.summary, 600),
    ageRange: text(o.ageRange, 30),
    occupation: text(o.occupation, 80),
    location: text(o.location, 80),
    interests: list(o.interests, 12),
    avoid: list(o.avoid, 8),
  };
  return persona.summary && persona.interests.length ? persona : null;
}

export const SUGGEST_SYSTEM = `You suggest real, existing subreddits for one person to join. Reply with JSON only.`;

export function buildSuggestPrompt(input: { persona: Persona; count: number; exclude: string[]; avoidShared: string[] }): string {
  const p = input.persona;
  const close = Math.max(1, Math.round(input.count / 3));
  return [
    `This is the person:`,
    `${p.summary}`,
    `Age ${p.ageRange}. Works as ${p.occupation}. Lives in ${p.location}.`,
    `Interests: ${p.interests.join(', ')}.`,
    `Never into: ${p.avoid.join(', ') || 'nothing listed'}.`,
    ``,
    `Suggest ${input.count} real subreddits this person would plausibly join.`,
    `- About ${close} close to their work or daily life ("close").`,
    `- Most from their interests and hobbies ("interest"), which do not need to relate to the work.`,
    `- A few everyday general ones anyone might enjoy ("general").`,
    `- Nothing that contradicts the person or touches what they are never into.`,
    `- Size matters: each must have roughly 1,000 to 50,000 weekly visitors. That rules out big well-known subreddits (r/books, r/diy, r/hiking, r/coffee, a big city's main sub). Choose the smaller, more specific community instead (a regional hiking sub, a brewing-method sub, a neighbourhood sub).`,
    `- No NSFW, no politics, no news, no meme subs.`,
    `- Only subreddits you are confident exist, spelled exactly.`,
    input.exclude.length ? `- Do not suggest any of these: ${input.exclude.join(', ')}.` : '',
    input.avoidShared.length ? `- Other people already follow these, so prefer different ones: ${input.avoidShared.join(', ')}.` : '',
    ``,
    `For each, up to 3 search keywords, in this order:`,
    `1-2. Two long-tail searches of 4 to 8 words, the way a person types into Reddit search, that would naturally bring this subreddit up. Example for r/candlemaking: "why is my soy candle tunneling", "best wicks for soy wax candles".`,
    `3. Last, the subreddit name written as ordinary words: r/candlemaking → "candle making", r/catlovers → "cat lover".`,
    `If a long-tail search would feel forced, leave it out rather than invent one. Never stuff the subreddit name into a phrase.`,
    ``,
    `JSON shape: {"communities": [{"name": "subredditname", "kind": "close"|"interest"|"general", "why": "one short reason", "keywords": [string]}]}`,
  ]
    .filter((l) => l !== '')
    .join('\n');
}

const KINDS: SuggestionKind[] = ['close', 'interest', 'general'];

/** The model's suggestions, cleaned: real-looking names only, nothing in
 *  `exclude`, no repeats, at most 3 keywords each. */
export function parseSuggestions(raw: unknown, exclude: string[]): CommunitySuggestion[] {
  const rows = (raw as { communities?: unknown } | null)?.communities;
  if (!Array.isArray(rows)) return [];
  const skip = new Set(normalizeSubredditList(exclude));
  const out: CommunitySuggestion[] = [];
  for (const r of rows) {
    const o = r as Record<string, unknown>;
    // Strict: a malformed name is dropped, never repaired into a different one.
    const bare = String(o?.name ?? '').trim().replace(/^\/?r\//i, '');
    if (!/^[A-Za-z0-9_]{2,21}$/.test(bare)) continue;
    const name = bare.toLowerCase();
    if (skip.has(name)) continue;
    skip.add(name);
    out.push({
      name,
      kind: KINDS.includes(o.kind as SuggestionKind) ? (o.kind as SuggestionKind) : 'interest',
      why: text(o.why, 160),
      keywords: normalizeKeywordList(o.keywords).slice(0, 3),
    });
  }
  return out;
}

/** A recorded check, or null when there is none worth reading. */
export function readCommunityCheck(raw: unknown): CommunityCheck | null {
  const o = raw as Record<string, unknown> | null;
  if (!o || typeof o !== 'object') return null;
  const status = o.status === 'passed' || o.status === 'rejected' ? o.status : 'pending';
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    status,
    hard: status === 'rejected' && o.hard === true,
    reason: text(o.reason, 160),
    weeklyVisitors: num(o.weeklyVisitors),
    moderators: num(o.moderators),
    apps: list(o.apps, 12, 40),
    checkedAtMs: num(o.checkedAtMs) ?? 0,
  };
}

function checksWhere(checks: unknown, test: (c: CommunityCheck) => boolean): Set<string> {
  const out = new Set<string>();
  if (!checks || typeof checks !== 'object') return out;
  for (const [name, raw] of Object.entries(checks as Record<string, unknown>)) {
    const c = readCommunityCheck(raw);
    if (c && test(c)) out.add(name.toLowerCase());
  }
  return out;
}

/** Private, quarantined or adult: never browsed, joined or commented in. */
export function blockedCommunities(checks: unknown): Set<string> {
  return checksWhere(checks, (c) => c.status === 'rejected' && c.hard);
}

/** Outside the commenting limits, or blocked outright: never commented in.
 *  Joining and browsing a big community quietly is fine. */
export function notForComments(checks: unknown): Set<string> {
  return checksWhere(checks, (c) => c.status === 'rejected');
}
